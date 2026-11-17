"""在 person-only 数据上微调 YOLO11n。

这个脚本只负责训练和如实打印验证集检测指标，不把 mAP 冒充“人数计数准确率”。
人数计数还需要用同一套线上推理流程（含切片、中心点归属、人形过滤）单独
对比 labels 里的人工人数。

典型用法（从仓库根目录）：
    python train/finetune.py --data train/person.yaml --imgsz 1024 \
        --epochs 60 --batch 8 --device cpu

生产推理是 CPU，但训练通常应在 GPU 上完成；CPU 训练 1024 输入会很慢，不要
把训练流程塞进线上 Docker 镜像。
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

DEFAULT_DATA = Path(__file__).resolve().with_name("person.yaml")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="在 person-only YOLO 数据上微调 YOLO11n",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument(
        "--data",
        default=str(DEFAULT_DATA),
        help="数据集 YAML（本目录的 person.yaml）",
    )
    parser.add_argument(
        "--weights",
        default="yolo11n.pt",
        help="预训练权重；离线环境请换成本地权重路径",
    )
    parser.add_argument("--imgsz", type=int, default=1024, help="训练输入尺寸")
    parser.add_argument("--epochs", type=int, default=60, help="训练轮数")
    parser.add_argument("--batch", type=int, default=8, help="批大小；CPU 上通常要调小")
    parser.add_argument("--device", default="cpu", help="cpu、0 或 0,1 等 Ultralytics 设备字符串")
    parser.add_argument("--workers", type=int, default=2, help="数据加载线程数")
    parser.add_argument("--project", default="runs/person", help="训练输出根目录")
    parser.add_argument("--name", default="yolo11n-person", help="本次训练输出子目录")
    parser.add_argument("--patience", type=int, default=15,
                        help="验证指标多少轮没提升就早停；0 表示不早停")
    parser.add_argument("--resume", action="store_true",
                        help="从上次中断处继续（指向 runs 里那次的 last.pt 需要配合 --weights）")
    parser.add_argument("--cache", action="store_true",
                        help="把图片缓存进内存/磁盘，显存够时能明显提速")
    parser.add_argument("--skip-preflight", action="store_true",
                        help="跳过训练前的数据体检（不推荐：空标签与多类标签会让训练白跑）")
    return parser.parse_args()


def _read_yaml_basic(text: str) -> Dict[str, Any]:
    """极简 YAML 读取（只认 `key: value` 与 `key: [a, b]`）。

    为什么需要它：`prepare_dataset.py` 生成的 `person.yaml` 只有五行，
    而 PyYAML 是 ultralytics 的依赖、不一定在体检环境里装好。没有 yaml 时
    直接跳过体检等于让这个检查在最需要它的机器上消失 —— 所以给一个够用的
    退化实现，**能解析我们自己的产物**，复杂 YAML 仍交给 PyYAML。
    """

    data: Dict[str, Any] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        key = key.strip()
        value = value.strip()
        if not value:
            data[key] = None
        elif value.startswith("[") and value.endswith("]"):
            data[key] = [item.strip().strip("\"'") for item in value[1:-1].split(",") if item.strip()]
        else:
            data[key] = value.strip("\"'")
    return data


def preflight(data_path: Path) -> Dict[str, Any]:
    """训练前把数据体检一遍：**这一步能省掉一整晚的无效训练**。

    三类问题都"训练不报错、只是训出个废模型"：

    1. **标签目录对不上图片目录**：全部是空标签 → 模型学会"画面里永远没人"。
    2. **标签里有非 0 类号**：`single_cls=True` 会把它们**静默合并**成 person，
       于是 rider、动物都成了人。这是最隐蔽的一类。
    3. **坐标没归一化**（大于 1）：ultralytics 会裁到边界，框全挤在右下角。

    统计不到就如实返回，不阻断训练（可能只是 yaml 写法少见）。
    """

    result: Dict[str, Any] = {"ok": False, "splits": {}, "warnings": []}
    text = data_path.read_text(encoding="utf-8")
    try:
        import yaml  # ultralytics 的依赖里自带
        config = yaml.safe_load(text) or {}
    except ImportError:
        config = _read_yaml_basic(text)
    except Exception:  # noqa: BLE001 - 读不出来就跳过体检
        result["warnings"].append("无法解析数据集 YAML，已跳过体检")
        return result
    if not isinstance(config, dict):
        result["warnings"].append("数据集 YAML 不是键值结构，已跳过体检")
        return result

    base = Path(config.get("path") or data_path.parent)
    names = config.get("names")
    if isinstance(names, dict):
        names = list(names.values())
    if isinstance(names, (list, tuple)) and len(names) > 1:
        result["warnings"].append("names 里有 %d 个类别；B2 只训 person 单类，请先确认标签只有 0" % len(names))

    for split in ("train", "val"):
        raw = config.get(split)
        if raw is None:
            continue
        roots = raw if isinstance(raw, (list, tuple)) else [raw]
        images = labels = empty = boxes = 0
        bad_class = unnormalized = 0
        missing_label = 0
        for entry in roots:
            image_dir = (base / str(entry)).resolve()
            if not image_dir.is_dir():
                result["warnings"].append("%s 目录不存在：%s" % (split, image_dir))
                continue
            for image_path in image_dir.rglob("*"):
                if image_path.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                    continue
                images += 1
                label_path = Path(str(image_path.parent).replace("images", "labels")) / (image_path.stem + ".txt")
                if not label_path.is_file():
                    missing_label += 1
                    continue
                labels += 1
                lines = [line.split() for line in label_path.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
                if not lines:
                    empty += 1
                for parts in lines:
                    boxes += 1
                    if len(parts) < 5:
                        continue
                    try:
                        if int(float(parts[0])) != 0:
                            bad_class += 1
                        if any(float(value) > 1.0 or float(value) < 0.0 for value in parts[1:5]):
                            unnormalized += 1
                    except (TypeError, ValueError):
                        pass
        result["splits"][split] = {"images": images, "labels": labels, "empty": empty,
                                   "missingLabel": missing_label, "boxes": boxes,
                                   "badClass": bad_class, "unnormalized": unnormalized}
        if images and missing_label == images:
            result["warnings"].append("%s: **所有**图片都没有标签文件，训练会学到'永远没人'" % split)
        elif images and empty >= max(1, images * 0.5):
            result["warnings"].append("%s: 一半以上是空标签（%d/%d），确认这是无人的负样本" % (split, empty, images))
        if bad_class:
            result["warnings"].append("%s: 出现 %d 个非 0 类号 —— single_cls 会把它们静默合并成 person" % (split, bad_class))
        if unnormalized:
            result["warnings"].append("%s: 出现 %d 个坐标不在 0—1 之间，框会被裁到边界" % (split, unnormalized))
    result["ok"] = True
    return result


def _results_dict(candidate: Any) -> Dict[str, Any]:
    """从 Ultralytics 的 metrics 对象/字典中取 results_dict。"""

    if isinstance(candidate, Mapping):
        nested = candidate.get("results_dict")
        if isinstance(nested, Mapping):
            return dict(nested)
        return dict(candidate)

    results = getattr(candidate, "results_dict", None)
    if isinstance(results, Mapping):
        return dict(results)
    return {}


def _finite_metric(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _first_metric(data: Mapping[str, Any], keys: List[str]) -> Optional[float]:
    for key in keys:
        if key in data:
            value = _finite_metric(data.get(key))
            if value is not None:
                return value
    return None


def _coalesce(*values: Optional[float]) -> Optional[float]:
    """返回第一个非 None 的指标；不能用 `or`，否则 0.0 会被误判为空。"""

    for value in values:
        if value is not None:
            return value
    return None


def _extract_metrics(train_output: Any, model: Any) -> Dict[str, Optional[float]]:
    """尽力从训练返回值/ trainer / model.metrics 中提取四个指标。

    不同 Ultralytics 小版本返回的对象略有差异，所以逐层尝试；取不到就返回
    None，由打印函数显示“未取得”，绝不编造数值。所有指标都是检测指标。
    """

    candidates: List[Any] = [train_output]
    trainer = getattr(model, "trainer", None)
    if trainer is not None:
        candidates.append(getattr(trainer, "metrics", None))
    candidates.append(getattr(model, "metrics", None))

    for candidate in candidates:
        if candidate is None:
            continue
        data = _results_dict(candidate)
        if data:
            box = getattr(candidate, "box", None)
            return {
                "mAP50": _coalesce(
                    _first_metric(data, ["metrics/mAP50(B)"]),
                    _finite_metric(getattr(box, "map50", None)),
                ),
                "mAP50-95": _coalesce(
                    _first_metric(data, ["metrics/mAP50-95(B)"]),
                    _finite_metric(getattr(box, "map", None)),
                ),
                "precision": _coalesce(
                    _first_metric(data, ["metrics/precision(B)"]),
                    _finite_metric(getattr(box, "mp", None)),
                ),
                "recall": _coalesce(
                    _first_metric(data, ["metrics/recall(B)"]),
                    _finite_metric(getattr(box, "mr", None)),
                ),
            }

    return {
        "mAP50": None,
        "mAP50-95": None,
        "precision": None,
        "recall": None,
    }


def _format_metric(value: Optional[float]) -> str:
    return "未取得" if value is None else f"{value:.4f}"


def main() -> None:
    args = parse_args()

    data_path = Path(args.data).expanduser()
    if not data_path.is_file():
        raise SystemExit(f"数据集 YAML 不存在：{data_path}")
    if args.imgsz <= 0 or args.epochs <= 0 or args.batch <= 0:
        raise SystemExit("--imgsz、--epochs、--batch 必须是正整数")

    try:
        from ultralytics import YOLO
    except ImportError as exc:
        raise SystemExit("未安装 ultralytics，请先按 requirements.txt 安装依赖") from exc

    model = YOLO(args.weights)

    if not args.skip_preflight:
        report = preflight(data_path)
        if report.get("ok"):
            print("\n===== 训练前数据体检 =====")
            for split, row in report["splits"].items():
                print("%-5s 图 %5d · 有标签 %5d · 空标签 %4d · 缺标签 %4d · 框 %6d · 非0类 %3d · 未归一化 %3d"
                      % (split, row["images"], row["labels"], row["empty"], row["missingLabel"],
                         row["boxes"], row["badClass"], row["unnormalized"]))
            if report["warnings"]:
                for warning in report["warnings"]:
                    print("  ⚠️ " + warning)
                print("  体检发现问题。训练仍会继续 —— 但上面几条会直接决定这次训练有没有意义。")
            else:
                print("  未发现明显问题。")

    train_kwargs = {
        "data": str(data_path),
        "imgsz": args.imgsz,
        "epochs": args.epochs,
        "batch": args.batch,
        "device": args.device,
        "workers": args.workers,
        "single_cls": True,
        "patience": max(0, args.patience),
        "cache": bool(args.cache),
        "verbose": True,
    }
    if args.resume:
        # 断点续训：Ultralytics 会从 args.weights 指向的 last.pt 继续，
        # 因此这里不能传 project/name/学习率等会覆盖原有配置的参数。
        train_output = model.train(resume=True)
    else:
        # 为什么这样设置：
        # * single_cls=True：线上只认 person 一类。注意它**不会替你清洗标签**，
        #   非 0 类会被静默合并成 person —— 所以 preflight 要先把它们查出来。
        # * mosaic/close_mosaic：增强人群密度与遮挡场景；最后 10 轮关闭 mosaic，
        #   让模型在更接近原图的分布上收敛。
        # * scale、fliplr、hsv_s：人多、尺度变化大、光照复杂；不做旋转是因为
        #   人通常是竖直的，degrees=0 可减少不必要形变。
        # * copy_paste 在小目标/遮挡上有帮助，但不同 Ultralytics 版本对检测任务
        #   的实现可能不同，以运行日志为准。
        train_output = model.train(
            project=args.project,
            name=args.name,
            mosaic=1.0,
            close_mosaic=10,
            scale=0.6,
            copy_paste=0.2,
            degrees=0,
            fliplr=0.5,
            hsv_s=0.5,
            **train_kwargs,
        )

    metrics = _extract_metrics(train_output, model)
    print("\n===== 验证集检测指标 =====")
    print(f"mAP50: {_format_metric(metrics['mAP50'])}")
    print(f"mAP50-95: {_format_metric(metrics['mAP50-95'])}")
    print(f"单类 Precision: {_format_metric(metrics['precision'])}")
    print(f"单类 Recall: {_format_metric(metrics['recall'])}")
    print(
        "注意：以上是检测指标（mAP/P/R），不是人数计数准确率。"
        "计数误差必须使用 labels 里的人工人数另行计算，"
        "不能把 mAP 或 P/R 当作计数准确率。"
    )

    trainer = getattr(model, "trainer", None)
    save_dir = getattr(trainer, "save_dir", None)
    if save_dir:
        print(f"训练输出目录：{save_dir}")
        best = Path(str(save_dir)) / "weights" / "best.pt"
        print("")
        print("下一步（**必须做**，否则这次训练没法证明比 B1 好）：")
        print("  1) 用同一批人工标注照片，把 B2 权重跑一遍标定表：")
        print("     python tools/calibrate.py --manifest labels.json --weights %s --out b2.json" % best)
        print("  2) 再给 B1（官方 yolo11n）跑一份：")
        print("     python tools/calibrate.py --manifest labels.json --weights yolo11n.pt --out b1.json")
        print("  3) 两张表并排比：")
        print("     node scripts/crowd-eval.js --set b1.json --grid")
        print("     node scripts/crowd-eval.js --set b2.json --grid")
        print("  4) 只有 MAE 明确更低、且偏差方向没变差，才把 person.pt 换进服务。")


if __name__ == "__main__":
    main()
