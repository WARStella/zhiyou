# -*- coding: utf-8 -*-
"""B1 档的置信度标定：在**人工标注**的样本上扫 conf（可选同时扫 NMS IoU）。

    python tools/calibrate.py --manifest labels.json --out predictions.json
    python tools/calibrate.py --manifest labels.json --iou-sweep 0.4,0.5,0.6
    node scripts/crowd-eval.js --set predictions.json --grid

为什么需要它：服务里 `YOLO_CONF` 默认 0.35 是**经验值**，不是在这个项目的
照片上调出来的。人群照片的置信度分布和 COCO 差得很远 —— 远处的人分低、
贴在一起的人框互相压。不标定就直接报"计数误差"，等于报了一个跟阈值绑定
的随机数。

三个设计决定：

1. **推理只跑一遍**：用很低的门限（默认 0.10）跑一次，把门限挪到后处理里扫
   （`person.counts_by_threshold`）。9 个阈值 × 每阈值全量重跑，在 CloudBase
   的 CPU 上是几十分钟的差别。
2. **本脚本不算指标**：MAE / RMSE / bias 只在 `scripts/crowd-eval.js` 里算。
   两处各写一份误差公式必然漂移，而漂移的表现是"脚本说 0.8、报告说 1.2"，
   两边都不报错。
3. **算不出来的事就直说**：没有标注就退出并说明，不生成一份"看起来像结果"
   的空表。
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SERVICE_DIR))

from detector import (  # noqa: E402
    DEFAULT_CONFIDENCE,
    DEFAULT_GRID,
    DEFAULT_IMGSZ,
    DEFAULT_MAX_DET,
    DEFAULT_OVERLAP,
    DEFAULT_WEIGHTS,
    DetectorError,
    PersonDetector,
    WeightsMissingError,
)
from person import counts_by_threshold  # noqa: E402

# 标定时用的"全留"门限。**必须低于要扫的最小阈值**，否则低阈值那一档
# 会因为推理时就被丢掉而永远数不准，而报告里看不出来。
LOW_CONF = 0.10


def parse_thresholds(raw: str) -> List[float]:
    """`0.20:0.60:0.05` 或 `0.25,0.35,0.45`。"""
    if ":" in raw:
        parts = raw.split(":")
        if len(parts) != 3:
            raise argparse.ArgumentTypeError("阈值网格格式应为 start:end:step")
        start, end, step = (float(item) for item in parts)
        if step <= 0 or end < start:
            raise argparse.ArgumentTypeError("阈值网格的 step 必须 > 0 且 end >= start")
        values: List[float] = []
        current = start
        # 用整数倍推进，避免 0.30000000000000004 这种浮点尾巴被写进报告
        index = 0
        while current <= end + 1e-9:
            values.append(round(start + index * step, 4))
            index += 1
            current = start + index * step
        return values
    return [round(float(item), 4) for item in raw.split(",") if item.strip()]


def load_manifest(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        raise SystemExit("找不到标注文件：%s" % path)
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    samples = data.get("samples") or []
    if not samples:
        raise SystemExit(
            "标注文件里没有样本（%s）。\n"
            "标定需要：每张照片一条 {id, image, expected}，expected 是人工数出来的人数。\n"
            "没有标注就不做标定 —— 编一份空表只会让人误以为已经量过了。" % path
        )
    for index, row in enumerate(samples):
        if not isinstance(row, dict):
            raise SystemExit("第 %d 条样本不是对象" % (index + 1))
        if not isinstance(row.get("image"), str) or not row["image"].strip():
            raise SystemExit("第 %d 条样本缺少 image" % (index + 1))
        expected = row.get("expected")
        if not isinstance(expected, int) or isinstance(expected, bool) or expected < 0:
            raise SystemExit("第 %d 条样本的 expected 必须是非负整数" % (index + 1))
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description="人群计数的 conf / IoU 标定（B1）")
    parser.add_argument("--manifest", required=True, help="标注文件：{samples:[{id,image,expected}]}")
    parser.add_argument("--out", default="predictions.json", help="输出的预测表，交给 crowd-eval --grid")
    parser.add_argument("--thresholds", type=parse_thresholds, default=parse_thresholds("0.20:0.60:0.05"))
    parser.add_argument("--iou-sweep", default="0.5", help="逗号分隔的 NMS IoU；每个值要重跑一遍推理")
    parser.add_argument("--imgsz", type=int, default=DEFAULT_IMGSZ)
    parser.add_argument("--grid", type=int, default=DEFAULT_GRID)
    parser.add_argument("--overlap", type=float, default=DEFAULT_OVERLAP)
    parser.add_argument("--tiling-mode", default="auto", choices=("auto", "force", "off"))
    parser.add_argument("--weights", default=os.environ.get("YOLO_WEIGHTS", DEFAULT_WEIGHTS))
    parser.add_argument("--max-det", type=int, default=max(DEFAULT_MAX_DET, 500),
                        help="标定时放宽上限，避免高密度照片在低阈值处被截断")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    thresholds = sorted({round(float(item), 4) for item in args.thresholds})
    if not thresholds:
        raise SystemExit("阈值列表为空")
    ious = [round(float(item), 4) for item in args.iou_sweep.split(",") if item.strip()]
    if not ious:
        raise SystemExit("IoU 列表为空")

    low_conf = min(LOW_CONF, round(min(thresholds) / 2, 4))
    manifest_path = Path(args.manifest).resolve()
    data = load_manifest(manifest_path)
    base_dir = manifest_path.parent
    samples = data["samples"]

    images: List[Any] = []
    for row in samples:
        image_path = (base_dir / row["image"]).resolve() if not Path(row["image"]).is_absolute() else Path(row["image"])
        if not image_path.is_file():
            raise SystemExit("找不到照片：%s（第 %s 条）" % (image_path, row.get("id") or row["image"]))
        images.append({
            "id": str(row.get("id") or image_path.name),
            "expected": int(row["expected"]),
            "path": image_path,
            "scene": row.get("scene"),
        })

    print("标注样本：%d 张" % len(images))
    print("扫描阈值：%s" % ", ".join("%.2f" % value for value in thresholds))
    print("NMS IoU ：%s" % ", ".join("%.2f" % value for value in ious))
    print("输入尺寸：%d · 切片 %s · 低门限 %.2f" % (args.imgsz, args.tiling_mode, low_conf))
    print("")

    groups: List[Dict[str, Any]] = []
    for iou in ious:
        detector = PersonDetector(
            weights=args.weights,
            imgsz=args.imgsz,
            conf=low_conf,
            iou=iou,
            max_det=args.max_det,
            grid=args.grid,
            overlap=args.overlap,
            device=args.device,
            tiling_mode=args.tiling_mode,
        )
        try:
            detector.load()
        except WeightsMissingError as exc:
            print("权重不可用：%s" % exc)
            print("标定必须在有真实权重的机器上跑（本机没有 torch/ultralytics 时也会走到这里）。")
            return 2
        except DetectorError as exc:  # pragma: no cover - 环境问题
            print("检测器初始化失败：%s" % exc)
            return 2

        per_threshold: Dict[float, List[Dict[str, Any]]] = {value: [] for value in thresholds}
        for index, item in enumerate(images, start=1):
            payload = detector.count(item["path"].read_bytes())
            rows = counts_by_threshold(payload["boxes"], thresholds)
            for row in rows:
                per_threshold[row["threshold"]].append({
                    "id": item["id"],
                    "expected": item["expected"],
                    "predicted": int(row["count"]),
                    "scene": item["scene"],
                })
            print("  [iou %.2f] %d/%d %s → 检出 %d 框（%d ms）"
                  % (iou, index, len(images), item["id"], payload["count"],
                     payload["quality"].get("inferenceMs") or 0))

        groups.append({
            "iou": iou,
            "grid": [{"threshold": value, "samples": per_threshold[value]} for value in thresholds],
        })
        print("")

    output = {
        "meta": {
            "name": (data.get("meta") or {}).get("name") or manifest_path.stem,
            "synthetic": False,
            "source": str(manifest_path),
            "samples": len(images),
            "thresholds": thresholds,
            "ious": ious,
            "imgsz": args.imgsz,
            "tilingMode": args.tiling_mode,
            "grid": args.grid,
            "overlap": args.overlap,
            "lowConf": low_conf,
            "weights": Path(args.weights).name,
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
        "groups": groups,
    }
    out_path = Path(args.out)
    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)

    print("已写出：%s" % out_path)
    print("下一步：node scripts/crowd-eval.js --set %s --grid" % out_path.name)
    print("（误差指标只在 Node 侧算一处，这里不重复实现。）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
