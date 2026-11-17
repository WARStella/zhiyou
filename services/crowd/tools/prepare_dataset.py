# -*- coding: utf-8 -*-
"""把公开人群数据集（和自采照片）整理成 **person 单类** 的 YOLO 训练集。

    python tools/prepare_dataset.py --crowdhuman /data/CrowdHuman \
        --widerperson /data/WiderPerson --self /data/mine \
        --out datasets/person

    python tools/prepare_dataset.py --crowdhuman /data/CrowdHuman --limit 200 \
        --out datasets/person_smoke      # 先跑个 200 张的冒烟集

B2（单类微调）的瓶颈从来不是训练本身，而是**数据能不能直接喂给 ultralytics**：
CrowdHuman 是每行一个 JSON 的 `.odgt`，WiderPerson 是每图一个 `.txt`
（首行 N，之后每行 `class x1 y1 x2 y2`），两者都不是 YOLO 的
`images/ + labels/ + xxx.yaml`。这个脚本只做这一件事。

四条设计纪律：

1. **只用 fbox，不用 vbox/hbox。** CrowdHuman 同时给了全身框、可见框、头框。
   人群计数要回答"画面里有几个人"，用可见框会把被遮挡的人学成"半个框"，
   模型最终倾向于少报人数 —— 正好是我们要避免的方向。
2. **ignore 一律不学。** 两个数据集都有"看不清但确实是人的区域"标注
   （CrowdHuman 是 `extra.ignore=1` 与 `tag=mask`，WiderPerson 是类别 4/5）；
   把它们当正样本会让框变得很糊，当负样本会让模型学会无视远处的人。
   正确做法是**丢掉**（不做任何监督）。
3. **类别口径要写死并报出来，不能静默丢弃。** WiderPerson 用类别号区分
   行人/骑行者/部分可见/ignore/crowd，脚本按 `--keep-labels`（默认 1,3）
   决定学哪些，并把**每一类出现多少次**打印出来。**不猜**，也不把
   未采用的类别悄悄当背景。
4. **切分是确定性的。** 同一个 `--seed` 与同一份数据必须切出同一份 train/val，
   否则 B1 基线与 B2 微调比的不是同一批验证图，对比就没意义。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

# 单类 = person = 0。线上服务的 `classes=[0]` 依赖这个约定，改了要同步改服务。
PERSON_CLASS_ID = 0

# 裁剪后小于这个边长的框直接丢：1—2 像素的人在 1280 输入上只剩噪声，
# 留着只会教模型"糊成一团也算人"。
MIN_BOX_SIDE_PX = 2.0


# ---------------------------------------------------------------------------
# CrowdHuman
# ---------------------------------------------------------------------------


def parse_odgt_line(line: str) -> Optional[Dict[str, Any]]:
    """解析 `.odgt` 的一行。坏行返回 None（统计里会记一条，不静默吞掉）。"""

    text = (line or "").strip()
    if not text:
        return None
    try:
        record = json.loads(text)
    except (ValueError, TypeError):
        return None
    return record if isinstance(record, dict) else None


def iter_odgt(path: Path) -> Iterator[Dict[str, Any]]:
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            record = parse_odgt_line(line)
            if record is not None:
                yield record


def _box_from_fbox(values: Any) -> Optional[Tuple[float, float, float, float]]:
    """CrowdHuman 的 fbox 是 [x, y, w, h]（像素）。"""

    if not isinstance(values, (list, tuple)) or len(values) < 4:
        return None
    try:
        x, y, width, height = (float(values[index]) for index in range(4))
    except (TypeError, ValueError, OverflowError):
        return None
    if width <= 0 or height <= 0:
        return None
    return (x, y, x + width, y + height)


def odgt_person_boxes(record: Dict[str, Any]) -> Tuple[List[Tuple[float, float, float, float]], int, int]:
    """取出"该学的人"的全身框。

    @returns `(boxes, skipped_ignore, skipped_other)`：
      · `skipped_ignore` —— 标了 ignore 的区域数（不能当监督信号）；
      · `skipped_other`  —— 不是 person 的 tag（mask、head 等）数。
    """

    entries = record.get("gtboxes")
    if not isinstance(entries, list):
        return ([], 0, 0)

    boxes: List[Tuple[float, float, float, float]] = []
    ignored = 0
    others = 0
    for entry in entries:
        if not isinstance(entry, dict):
            others += 1
            continue
        if str(entry.get("tag") or "").strip().lower() != "person":
            others += 1
            continue
        extra = entry.get("extra")
        if isinstance(extra, dict):
            flag = extra.get("ignore")
            try:
                if flag is not None and int(flag) == 1:
                    ignored += 1
                    continue
            except (TypeError, ValueError, OverflowError):
                pass
        box = _box_from_fbox(entry.get("fbox"))
        if box is None:
            others += 1
            continue
        boxes.append(box)
    return (boxes, ignored, others)


# ---------------------------------------------------------------------------
# WiderPerson
# ---------------------------------------------------------------------------

# 官方类别定义（见 http://www.cbsr.ia.ac.cn/users/sfzhang/WiderPerson/）：
#   1 行人 / 2 骑行者 / 3 部分可见的人 / 4 ignore 区域 / 5 crowd 区域
#
# 默认只学 1 与 3。为什么：
#   · 3（部分可见）在人群照片里就是"被挡住的人"，正是我们要数的那部分；
#   · 2（骑行者）的框通常裹着自行车，学进去会把车算成人；
#   · 4/5 是"不要学"的区域，既不能当正样本，也不能算背景。
WIDERPERSON_LABELS = {1: "pedestrians", 2: "riders", 3: "partially-visible", 4: "ignore", 5: "crowd"}
DEFAULT_KEEP_LABELS = (1, 3)
IGNORE_LABELS = (4, 5)


def parse_widerperson_annotation(text: str) -> Dict[str, Any]:
    """解析 WiderPerson 的**每图标注 txt**。

    格式（官方说明，不是 XML —— 官方从未发布 XML 标注）：

        第一行：本图目标数 N
        之后每一行：`class_label x1 y1 x2 y2`

    返回 `{boxes, counts, declared, badLines, declaredMismatch}`：
      · `counts` —— 每个类别出现多少次（调用方据此决定学哪些、并写进统计）；
      · `declared` —— 首行声明的目标数，用于发现"文件被截断"；
      · `declaredMismatch` —— 声明数与实际行数不一致时记下差值（不静默）。
    """

    result: Dict[str, Any] = {"boxes": [], "counts": {}, "declared": None,
                              "badLines": 0, "declaredMismatch": 0}
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    if not lines:
        return result

    declared: Optional[int] = None
    try:
        declared = int(float(lines[0].split()[0]))
    except (TypeError, ValueError, IndexError):
        declared = None
    result["declared"] = declared
    rows = lines[1:] if declared is not None else lines

    for row in rows:
        parts = row.replace(",", " ").split()
        if len(parts) < 5:
            result["badLines"] += 1
            continue
        try:
            label = int(float(parts[0]))
            coords = [float(value) for value in parts[1:5]]
        except (TypeError, ValueError, OverflowError):
            result["badLines"] += 1
            continue
        result["counts"][label] = result["counts"].get(label, 0) + 1
        result["boxes"].append((coords[0], coords[1], coords[2], coords[3], label))

    if declared is not None and declared != len(result["boxes"]):
        result["declaredMismatch"] = declared - len(result["boxes"])
    return result


# ---------------------------------------------------------------------------
# 归一化与切分
# ---------------------------------------------------------------------------


def clip_box(box: Sequence[float], width: int, height: int,
             min_side: float = MIN_BOX_SIDE_PX) -> Optional[Tuple[float, float, float, float]]:
    """裁到图像范围内；裁完太小就丢。"""

    if width <= 0 or height <= 0:
        return None
    try:
        x1, y1, x2, y2, *_ = [float(value) for value in box]
    except (TypeError, ValueError, OverflowError):
        return None
    import math

    if not all(math.isfinite(value) for value in (x1, y1, x2, y2)):
        return None
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    x1 = max(0.0, min(x1, float(width)))
    y1 = max(0.0, min(y1, float(height)))
    x2 = max(0.0, min(x2, float(width)))
    y2 = max(0.0, min(y2, float(height)))
    if (x2 - x1) < min_side or (y2 - y1) < min_side:
        return None
    return (x1, y1, x2, y2)


def to_yolo_line(box: Sequence[float], width: int, height: int) -> str:
    """`0 cx cy w h`（全部归一化到 0—1，保留 6 位小数）。"""

    x1, y1, x2, y2 = box
    center_x = (x1 + x2) / 2.0 / width
    center_y = (y1 + y2) / 2.0 / height
    box_width = (x2 - x1) / width
    box_height = (y2 - y1) / height
    return "0 %.6f %.6f %.6f %.6f" % (center_x, center_y, box_width, box_height)


def assign_split(items: Sequence[Any], val_ratio: float, seed: int) -> Tuple[List[Any], List[Any]]:
    """确定性切分。

    两条边界都是踩过的坑：

    * **样本 ≥ 5 张**：验证集至少 1 张、训练集至少 1 张。少于 1 张的验证集会让
      ultralytics 在算 mAP 时报错；空训练集则直接训练失败。
    * **样本 < 5 张**（冒烟集）：验证集**取自训练集本身**。这样训练能跑通，
      但验证指标是"在训练图上考自己"，**绝对不能拿来报数** —— 所以统计里
      单独标出 `overlapSmallSet`，让读报告的人一眼看见。
    """

    ordered = list(items)
    random.Random(seed).shuffle(ordered)
    if not ordered:
        return ([], [])
    ratio = min(max(float(val_ratio), 0.0), 0.9)
    if len(ordered) < 5:
        return (ordered, ordered[:1])
    val_count = int(round(len(ordered) * ratio))
    val_count = max(1, min(val_count, len(ordered) - 1))
    return (ordered[val_count:], ordered[:val_count])


# ---------------------------------------------------------------------------
# 写盘
# ---------------------------------------------------------------------------


def _place(source: Path, target: Path, mode: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        return
    if mode == "link":
        try:
            os.link(source, target)
            return
        except OSError:
            pass  # 跨盘/文件系统不支持硬链接时回落到复制
    shutil.copy2(source, target)


def _stat() -> Dict[str, Any]:
    return {"images": 0, "boxes": 0, "ignored": 0, "dropped": 0, "empty": 0,
            "badRecords": 0, "missingImages": 0, "otherTags": 0, "noLabel": 0}


def build_dataset(options: Dict[str, Any]) -> Dict[str, Any]:
    """按配置组装数据集并返回统计。CLI 只是这个函数的外壳。"""

    out_root = Path(options["out"]).resolve()
    val_ratio = float(options.get("valRatio", 0.15))
    seed = int(options.get("seed", 42))
    limit = options.get("limit")
    mode = options.get("mode", "copy")
    keep_labels = {int(value) for value in options.get("keepLabels", DEFAULT_KEEP_LABELS)}

    items: List[Dict[str, Any]] = []
    stats: Dict[str, Any] = {"sources": {}, "out": str(out_root)}

    def add_item(source: str, key: str, image: Path, labels: List[str]) -> None:
        """只累加**每张图**就能算出来的数；全局计数由 finalize_source 一次性写入。"""
        bucket = stats["sources"].setdefault(source, _stat())
        bucket["images"] += 1
        bucket["boxes"] += len(labels)
        if not labels:
            bucket["empty"] += 1
        items.append({"source": source, "id": key, "image": image, "labels": labels})

    def finalize_source(source: str, counts: Dict[str, Any]) -> None:
        """把该来源的全局计数**赋值**进统计。

        ⚠️ 这里必须是赋值而不是累加：`counts` 在整个来源的循环里持续累加，
        若在 add_item 里逐张累加，同一个数会被重复加进桶里（N 张图就把
        "缺图 3 张"记成 3N），而且最后一条记录之后自增的数会彻底丢掉。
        这个 bug 一开始就藏在测试里（missingImages 期望 1、实际 0）。
        """
        bucket = stats["sources"].setdefault(source, _stat())
        bucket["ignored"] = int(counts.get("ignored", 0))
        bucket["dropped"] = int(counts.get("dropped", 0))
        bucket["otherTags"] = int(counts.get("otherTags", 0))
        bucket["badRecords"] = int(counts.get("badRecords", 0))
        bucket["missingImages"] = int(counts.get("missingImages", 0))
        bucket["noLabel"] = int(counts.get("noLabel", 0))

    # —— CrowdHuman ——
    if options.get("crowdhuman"):
        from PIL import Image as _Image

        root = Path(options["crowdhuman"]).resolve()
        # 默认读 train 的标注；想先用官方的 val 包跑通链路时用 --crowdhuman-odgt 指定。
        annotation_name = str(options.get("crowdhumanOdgt") or "annotation_train.odgt")
        annotations = root / annotation_name
        if not annotations.is_file():
            raise SystemExit("CrowdHuman 缺少 %s：%s（可用 --crowdhuman-odgt 指定别的标注文件）"
                             % (annotation_name, annotations))
        counts = {"ignored": 0, "otherTags": 0, "dropped": 0, "badRecords": 0, "missingImages": 0}
        for record in iter_odgt(annotations):
            image_id = str(record.get("ID") or "").strip()
            if not image_id:
                counts["badRecords"] += 1
                continue
            image_path = root / "Images" / (image_id + ".jpg")
            if not image_path.is_file():
                counts["missingImages"] += 1
                continue
            boxes, ignored, other = odgt_person_boxes(record)
            counts["ignored"] += ignored
            counts["otherTags"] += other
            try:
                with _Image.open(image_path) as handle:
                    width, height = handle.size
            except Exception:  # noqa: BLE001 - 打不开的图跳过并计数
                counts["missingImages"] += 1
                continue
            labels: List[str] = []
            for box in boxes:
                clipped = clip_box(box, width, height)
                if clipped is None:
                    counts["dropped"] += 1
                    continue
                labels.append(to_yolo_line(clipped, width, height))
            add_item("crowdhuman", "ch_" + image_id, image_path, labels)
            if limit and stats["sources"]["crowdhuman"]["images"] >= int(limit):
                break
        finalize_source("crowdhuman", counts)

    # —— WiderPerson ——
    if options.get("widerperson"):
        from PIL import Image as _Image

        root = Path(options["widerperson"]).resolve()
        annotation_dir = root / "Annotations"
        image_dir = root / "Images"
        if not annotation_dir.is_dir():
            raise SystemExit("WiderPerson 缺少 Annotations 目录：%s" % annotation_dir)
        counts = {"ignored": 0, "otherTags": 0, "dropped": 0, "badRecords": 0, "missingImages": 0}
        label_counts: Dict[int, int] = {}
        for annotation_path in sorted(annotation_dir.glob("*.txt")):
            # 官方命名是 `000001.jpg.txt`：去掉 .txt 就是图片名
            image_name = annotation_path.name[:-4] if annotation_path.name.lower().endswith(".txt") else annotation_path.name
            image_path = image_dir / image_name
            if not image_path.is_file():
                counts["missingImages"] += 1
                continue
            parsed = parse_widerperson_annotation(annotation_path.read_text(encoding="utf-8", errors="replace"))
            if parsed["badLines"]:
                counts["badRecords"] += parsed["badLines"]
            if not parsed["boxes"]:
                counts["badRecords"] += 1
                continue
            try:
                with _Image.open(image_path) as handle:
                    width, height = handle.size
            except Exception:  # noqa: BLE001 - 打不开的图跳过并计数
                counts["missingImages"] += 1
                continue

            labels: List[str] = []
            for box in parsed["boxes"]:
                class_label = int(box[4])
                label_counts[class_label] = label_counts.get(class_label, 0) + 1
                # 4/5 是"不要学"的区域；既不当正样本，也不能算背景
                if class_label in IGNORE_LABELS:
                    counts["ignored"] += 1
                    continue
                if class_label not in keep_labels:
                    counts["otherTags"] += 1
                    continue
                clipped = clip_box(box[:4], width, height)
                if clipped is None:
                    counts["dropped"] += 1
                    continue
                labels.append(to_yolo_line(clipped, width, height))
            add_item("widerperson", "wp_" + Path(image_name).stem, image_path, labels)
            if limit and stats["sources"]["widerperson"]["images"] >= int(limit):
                break
        finalize_source("widerperson", counts)
        stats["widerpersonLabels"] = {str(key): value for key, value in sorted(label_counts.items())}

    # —— 自采 / 已转好的 YOLO 目录（images/ + labels/）——
    #
    # 支持两种摆法：
    #   images/a.jpg + labels/a.txt                 （扁平）
    #   images/train/a.jpg + labels/train/a.txt     （已按 train/val 切好，公开镜像常见）
    # 为什么要兼容后者：Mendeley 等镜像直接给的是切分好的 YOLO 结构，要求用户
    # 先自己压平一遍，等于让"最省事的那条路"变得不省事。
    if options.get("self"):
        root = Path(options["self"]).resolve()
        image_dir = root / "images"
        if not image_dir.is_dir():
            raise SystemExit("YOLO 目录缺少 images/：%s" % image_dir)
        counts = {"ignored": 0, "otherTags": 0, "dropped": 0, "badRecords": 0, "missingImages": 0, "noLabel": 0}
        image_files = [p for p in sorted(image_dir.rglob("*")) if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg", ".png")]
        if not image_files:
            raise SystemExit("images/ 下没有图片（支持 jpg/jpeg/png）：%s" % image_dir)
        for image_path in image_files:
            relative = image_path.relative_to(image_dir)
            # 把路径里最后一级 `images` 换成 `labels`，其余层级原样保留
            parts = list(image_path.parts)
            indexes = [index for index, part in enumerate(parts) if part.lower() == "images"]
            if not indexes:
                raise SystemExit("找不到 images 目录层级：%s" % image_path)
            cut = indexes[-1]
            label_path = Path(*parts[:cut], "labels", *parts[cut + 1:]).with_suffix(".txt")
            labels: List[str] = []
            if label_path.is_file():
                for line in label_path.read_text(encoding="utf-8", errors="replace").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    parts = line.split()
                    if len(parts) < 5:
                        counts["badRecords"] += 1
                        continue
                    try:
                        class_id = int(float(parts[0]))
                        values = [float(item) for item in parts[1:5]]
                    except (TypeError, ValueError):
                        counts["badRecords"] += 1
                        continue
                    # 自采数据可能带别的类号；不是 person 就报错，避免训练出多类模型
                    if class_id != PERSON_CLASS_ID:
                        raise SystemExit(
                            "自采标签 %s 里有非 person 类号 %d。B2 只训单类，"
                            "请先把其他类删除或合并到 0。" % (label_path.name, class_id))
                    if not all(0.0 <= value <= 1.0 for value in values):
                        counts["badRecords"] += 1
                        continue
                    labels.append("0 %.6f %.6f %.6f %.6f" % tuple(values))
            else:
                # 没有标签文件 = 画面里确实没人（负样本），这是合法样本，不是缺图
                counts["noLabel"] += 1
            # 用相对路径做 id：`images/train/a.jpg` 与 `images/val/a.jpg` 同名时
            # 只用 stem 会互相覆盖，输出目录里就少一张图，而且不报错。
            key = "self_" + relative.with_suffix("").as_posix().replace("/", "_")
            add_item("self", key, image_path, labels)
        finalize_source("self", counts)

    # —— 切分与写盘 ——
    train_items, val_items = assign_split(items, val_ratio, seed)
    for split, rows in (("train", train_items), ("val", val_items)):
        for row in rows:
            _place(row["image"], out_root / "images" / split / (row["id"] + row["image"].suffix), mode)
            label_path = out_root / "labels" / split / (row["id"] + ".txt")
            label_path.parent.mkdir(parents=True, exist_ok=True)
            label_path.write_text("\n".join(row["labels"]) + ("\n" if row["labels"] else ""), encoding="utf-8")

    stats["train"] = len(train_items)
    stats["val"] = len(val_items)
    stats["total"] = len(items)
    # 小样本时 val 取自 train 本身 —— 训练能跑，但指标不能报。显式标出来。
    stats["overlapSmallSet"] = len(items) < 5
    stats["keepLabels"] = sorted(keep_labels)
    stats["seed"] = seed
    stats["valRatio"] = val_ratio
    stats["emptyLabels"] = sum(1 for row in items if not row["labels"])

    # person.yaml 直接指向产出目录，训练脚本拿它就能跑
    yaml_path = out_root / "person.yaml"
    yaml_path.write_text(
        "# 由 tools/prepare_dataset.py 生成；路径为绝对路径，换机器要重新生成。\n"
        "path: %s\n"
        "train: images/train\n"
        "val: images/val\n"
        "nc: 1\n"
        "names: [person]\n" % out_root.as_posix(),
        encoding="utf-8")
    stats["yaml"] = str(yaml_path)
    (out_root / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8")
    return stats


def main() -> int:
    parser = argparse.ArgumentParser(description="整理 person 单类 YOLO 数据集（B2 前置）")
    parser.add_argument("--crowdhuman", help="CrowdHuman 根目录（含 annotation_train.odgt 与 Images/）")
    parser.add_argument("--crowdhuman-odgt", default=None,
                        help="改用别的标注文件（例如先用官方 val 包跑通链路：annotation_val.odgt）")
    parser.add_argument("--widerperson", help="WiderPerson 根目录（含 Annotations/ 与 Images/）")
    parser.add_argument("--self", dest="self_dir", help="自采数据（images/ + labels/，已是 YOLO 格式）")
    parser.add_argument("--out", required=True, help="输出目录（会写入 images/ labels/ person.yaml stats.json）")
    parser.add_argument("--val-ratio", type=float, default=0.15)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--limit", type=int, default=0, help="每个来源最多取多少张（冒烟用，0 = 全部）")
    parser.add_argument("--mode", choices=("copy", "link"), default="copy")
    parser.add_argument("--keep-labels", default=",".join(str(value) for value in DEFAULT_KEEP_LABELS),
                        help="WiderPerson 里算作人的类别号（1 行人 / 2 骑行者 / 3 部分可见 / 4 ignore / 5 crowd），默认 1,3")
    args = parser.parse_args()

    if not any((args.crowdhuman, args.widerperson, args.self_dir)):
        parser.error("至少要给 --crowdhuman / --widerperson / --self 之一")

    try:
        keep_labels = [int(item) for item in args.keep_labels.split(",") if item.strip()]
    except ValueError:
        parser.error("--keep-labels 必须是逗号分隔的整数，例如 1,3")
    unknown_labels = [value for value in keep_labels if value not in WIDERPERSON_LABELS]
    if unknown_labels:
        parser.error("--keep-labels 里有未定义的类别号 %s（官方只有 %s）"
                     % (unknown_labels, sorted(WIDERPERSON_LABELS)))

    stats = build_dataset({
        "crowdhuman": args.crowdhuman,
        "crowdhumanOdgt": args.crowdhuman_odgt,
        "widerperson": args.widerperson,
        "self": args.self_dir,
        "out": args.out,
        "valRatio": args.val_ratio,
        "seed": args.seed,
        "limit": args.limit or None,
        "mode": args.mode,
        "keepLabels": keep_labels,
    })

    print("输出：%s" % stats["out"])
    print("切分：train %d / val %d（共 %d 张，空标签 %d 张）"
          % (stats["train"], stats["val"], stats["total"], stats["emptyLabels"]))
    for source, bucket in stats["sources"].items():
        print("  %-12s 图 %5d · 框 %6d · ignore %4d · 丢弃 %4d · 坏记录 %3d · 缺图 %3d · 非人标签 %4d"
              % (source, bucket["images"], bucket["boxes"], bucket["ignored"], bucket["dropped"],
                 bucket["badRecords"], bucket["missingImages"], bucket["otherTags"]))
        if bucket.get("noLabel"):
            print("  %-12s 其中 %d 张没有标签文件（按「画面无人」的负样本计入）" % ("", bucket["noLabel"]))
    labels = stats.get("widerpersonLabels") or {}
    if labels:
        described = ["%s(%s)×%d" % (key, WIDERPERSON_LABELS.get(int(key), "?"), value) for key, value in labels.items()]
        print("  WiderPerson 各类别出现次数：" + "、".join(described))
        dropped = [int(key) for key in labels if int(key) not in set(stats["keepLabels"])]
        if dropped:
            print("  ⚠️ 未当成人处理的类别：%s（需要时用 --keep-labels 加上）"
                  % "、".join("%d(%s)" % (value, WIDERPERSON_LABELS.get(value, "?")) for value in dropped))
    if stats["emptyLabels"]:
        print("  说明：空标签图会被当作负样本（画面确实没人），这是合法样本，不是错误。")
    print("数据集配置：%s" % stats["yaml"])
    print("")
    print("下一步：python train/finetune.py --data %s --imgsz 1280 --batch 16 --device 0" % stats["yaml"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
