"""Ultralytics YOLO11 人形检测封装。

几个关键约束：

* ``ultralytics`` 只在 ``load()`` 里 import。这样 person.py 的标准库单测
  不需要 torch，也不需要在开发机上安装几个 GB 的依赖。
* 每次推理都传 ``classes=[0]``，只跑 person 一类；不是先跑 80 类再过滤。
  这既减少后处理，也避免其他类别占用 max_det 名额。
* 大类推理常把大图切片，本模块用 person.plan_tiles 生成重叠切片，并用
  core 中心点归属去重，避免切片缝上的人被算两次。
* 线程安全由 app.py 的 inference lock 负责，本模块不重复加锁。
"""

from __future__ import annotations

import io
import logging
import math
import re
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from PIL import Image, UnidentifiedImageError

from person import (
    PERSON_CLASS_ID,
    TILE_TRIGGER_RATIO,
    Box,
    Tile,
    cap_detections,
    filter_boxes,
    merge_tiles,
    nms,
    plan_tiles,
    quality_of,
    should_tile,
    to_normalized,
)

LOGGER = logging.getLogger(__name__)

DEFAULT_MODEL_NAME = "yolo11n-person"
DEFAULT_WEIGHTS = "person.pt"
FALLBACK_WEIGHTS = "yolo11n.pt"
# B1 档（推理侧特化）的默认输入分辨率。
#
# 为什么从 1024 提到 1280：人群照片的漏检主要发生在"远景里十几像素高的人"。
# 输入分辨率直接决定这些人还剩几个像素 —— 1024 下 12MP 原图会被缩 3.9 倍，
# 1280 下缩 3.15 倍，一个 40px 的人在特征图上从 10px 变成 12.5px，正好跨过
# 检测头的舒适区。代价是单次推理算力约 1.56 倍（像素数比），这是 B1 里
# **唯一**一个"多花算力换召回"的开关，所以它必须可关：`YOLO_IMGSZ=1024`。
DEFAULT_IMGSZ = 1280
DEFAULT_CONFIDENCE = 0.35
DEFAULT_IOU = 0.5
DEFAULT_MAX_DET = 300
DEFAULT_GRID = 2
DEFAULT_OVERLAP = 0.2
DEFAULT_MAX_PIXELS = 30_000_000
DEFAULT_TILING_MODE = "auto"
# CloudBase 云托管的 CPU 实例通常只有 1—2 核。torch 默认按物理核数开线程，
# 在受限容器里线程争抢反而让单张图延迟抖动（同一张图 0.8s—2.5s 都出现过）。
# 默认钉成 1 线程，把并行度交给平台的多实例，而不是容器内的多线程。
DEFAULT_TORCH_THREADS = 1
MAX_CONTRACT_DETECTIONS = 1000

# 与 Node 侧 ^yolo[\w.-]{1,60}$ 对齐。Python 的 \w 默认包含 Unicode，
# 这里显式 re.ASCII，避免中文模型名在本地通过、到 Node 却校验失败。
_MODEL_NAME_RE = re.compile(r"yolo[\w.-]{1,60}", re.IGNORECASE | re.ASCII)


class DetectorError(Exception):
    """detector 的统一异常，app.py 据此映射 HTTP 错误码。"""

    code = "INFERENCE_FAILED"

    def __init__(self, message: str = "检测失败", code: Optional[str] = None) -> None:
        self.code = code or type(self).code
        super().__init__(message)


class WeightsMissingError(DetectorError):
    """权重不可用；app.py 必须映射成 503 WEIGHTS_MISSING。"""

    code = "WEIGHTS_MISSING"


class InvalidImageError(DetectorError):
    """图片非法或解码失败；app.py 必须映射成 400 INVALID_IMAGE。"""

    code = "INVALID_IMAGE"


def _finite_float(value: Any, default: float) -> float:
    if isinstance(value, bool):
        return default
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return number if math.isfinite(number) else default


def _to_int(value: Any, default: int) -> int:
    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _sanitize_model_name(value: Any) -> str:
    candidate = value.strip() if isinstance(value, str) else ""
    if candidate and _MODEL_NAME_RE.fullmatch(candidate):
        return candidate
    if candidate:
        LOGGER.warning("YOLO_MODEL_NAME 不符合 Node 侧格式，已回退默认值")
    return DEFAULT_MODEL_NAME


def _class_count(model: Any) -> Optional[int]:
    """读出权重里有多少个类别。

    为什么必须有这个数：`classes=[0]` 让 80 类的官方权重和 1 类的微调权重在
    **输出上完全一样**，都是"只有 person 的框"。于是"部署了 person.pt"这件事
    无法从行为上验证 —— 有人把官方 yolo11n.pt 改名成 person.pt，界面、日志、
    契约全部照常通过。

    B2 做完的**可验证定义**就是这个数为 1。取不到返回 None（不猜），
    由 `/model` 如实显示 unknown，不冒充单类。
    """

    inner = getattr(model, "model", None)
    names = getattr(inner, "names", None)
    if names is None:
        names = getattr(model, "names", None)
    if isinstance(names, dict) and names:
        return len(names)
    if isinstance(names, (list, tuple)) and names:
        return len(names)
    for holder in (inner, model):
        count = getattr(holder, "nc", None)
        if isinstance(count, int) and not isinstance(count, bool) and count > 0:
            return count
    return None


class PersonDetector:
    """person-only YOLO11 检测器。"""

    def __init__(
        self,
        weights: str = DEFAULT_WEIGHTS,
        imgsz: int = DEFAULT_IMGSZ,
        conf: float = DEFAULT_CONFIDENCE,
        iou: float = DEFAULT_IOU,
        max_det: int = DEFAULT_MAX_DET,
        grid: int = DEFAULT_GRID,
        overlap: float = DEFAULT_OVERLAP,
        device: str = "cpu",
        model_name: str = DEFAULT_MODEL_NAME,
        max_pixels: int = DEFAULT_MAX_PIXELS,
        tiling_mode: str = DEFAULT_TILING_MODE,
        torch_threads: int = DEFAULT_TORCH_THREADS,
    ) -> None:
        raw_weights = weights.strip() if isinstance(weights, str) else ""
        self.weights = raw_weights or DEFAULT_WEIGHTS
        self.weights_name = Path(self.weights).name or DEFAULT_WEIGHTS
        self.active_weights_name: Optional[str] = None

        image_size = _to_int(imgsz, DEFAULT_IMGSZ)
        self.imgsz = max(32, image_size)

        confidence = _finite_float(conf, DEFAULT_CONFIDENCE)
        # 契约要求 0 < confidenceThreshold < 1；环境变量写 0 或 1 时也
        # 夹到开区间内，避免 Node 的严格校验失败。
        self.conf = min(max(confidence, 0.001), 0.999)

        iou_value = _finite_float(iou, DEFAULT_IOU)
        self.iou = min(max(iou_value, 0.01), 0.99)

        detection_limit = _to_int(max_det, DEFAULT_MAX_DET)
        # 契约 count <= 1000，所以这里也封顶，防止环境变量把上限放大后
        # 产生 Node 判定为异常的超长数组。
        self.max_det = min(max(detection_limit, 1), MAX_CONTRACT_DETECTIONS)

        grid_value = _to_int(grid, DEFAULT_GRID)
        self.grid = min(max(grid_value, 1), 4)

        overlap_value = _finite_float(overlap, DEFAULT_OVERLAP)
        self.overlap = min(max(overlap_value, 0.0), 0.5)

        device_value = device.strip() if isinstance(device, str) else ""
        self.device = device_value or "cpu"

        self.model_name = _sanitize_model_name(model_name)
        pixel_limit = _to_int(max_pixels, DEFAULT_MAX_PIXELS)
        self.max_pixels = pixel_limit if pixel_limit > 0 else DEFAULT_MAX_PIXELS

        mode_value = tiling_mode.strip().lower() if isinstance(tiling_mode, str) else ""
        self.tiling_mode = mode_value if mode_value in ("auto", "force", "off") else DEFAULT_TILING_MODE

        thread_value = _to_int(torch_threads, DEFAULT_TORCH_THREADS)
        self.torch_threads = min(max(thread_value, 0), 64)

        self._model: Any = None
        # 权重里的类别数：1 = B2 单类微调权重；80 = 官方 COCO（仅用 person 类）
        self.class_count: Optional[int] = None

    @property
    def ready(self) -> bool:
        return self._model is not None

    @property
    def resolved_weights_name(self) -> str:
        return self.active_weights_name or self.weights_name

    # ------------------------------------------------------------------
    # 权重加载
    # ------------------------------------------------------------------

    def _primary_candidates(self) -> List[Path]:
        """把 YOLO_WEIGHTS 解析成应用目录/当前目录下的候选文件。"""

        requested = Path(self.weights).expanduser()
        app_dir = Path(__file__).resolve().parent
        if requested.is_absolute():
            return [requested]
        return [(app_dir / requested).resolve(), (Path.cwd() / requested).resolve()]

    @staticmethod
    def _fallback_source() -> str:
        """返回本地 yolo11n.pt；不存在时交给 Ultralytics 的默认下载逻辑。

        Dockerfile 本身不下载权重。若部署环境没有挂载权重且允许外网，
        Ultralytics 可能会在首次调用时下载 yolo11n.pt；离线环境则会失败
        并由 app.py 如实返回 503。README 已说明生产环境应挂载权重。
        """

        fallback_name = FALLBACK_WEIGHTS
        bases = [Path(__file__).resolve().parent, Path.cwd()]
        for base in bases:
            candidate = (base / fallback_name).resolve()
            if candidate.is_file():
                return str(candidate)
        return fallback_name

    def load(self) -> None:
        """加载权重；自定义权重缺失/加载失败时回落官方 yolo11n.pt。

        Ultralytics 在权重文件不存在时可能尝试联网下载，这对生产环境并不
        可靠，所以优先检查本地文件；最终仍失败就抛 WEIGHTS_MISSING，由
        app.py 返回 503，而不是让 gunicorn 启动崩溃或返回一个空模型。
        """

        if self._model is not None:
            return

        # 线程数必须在第一次推理之前设置。设置失败不影响可用性（那是宿主环境
        # 的问题，不该让服务 503），但要留一行日志。
        if self.torch_threads > 0:
            try:
                import torch

                torch.set_num_threads(self.torch_threads)
                LOGGER.info("torch 线程数已固定为 %d", self.torch_threads)
            except Exception:  # noqa: BLE001 - 仅影响性能，不影响正确性
                LOGGER.warning("无法设置 torch 线程数，沿用默认值")

        candidates: List[Tuple[str, str]] = []
        for path in self._primary_candidates():
            if path.is_file():
                candidates.append((str(path), path.name))
                break

        fallback_source = self._fallback_source()
        fallback_label = Path(fallback_source).name or FALLBACK_WEIGHTS
        if all(source != fallback_source for source, _ in candidates):
            candidates.append((fallback_source, fallback_label))

        if not candidates:
            raise WeightsMissingError("检测权重不可用")

        for source, label in candidates:
            try:
                # 延迟 import：person.py 与 tests/ 不需要 torch/ultralytics。
                from ultralytics import YOLO

                model = YOLO(source)
            except Exception as exc:  # noqa: BLE001 - 权重加载失败都转 503
                LOGGER.warning(
                    "权重加载失败（%s）：%s",
                    label,
                    type(exc).__name__,
                )
                continue

            self._model = model
            self.active_weights_name = label
            self.class_count = _class_count(model)
            if self.class_count == 1:
                LOGGER.info("检测权重已加载：%s（单类，B2 微调权重）", label)
            elif self.class_count:
                LOGGER.info(
                    "检测权重已加载：%s（%d 类，仅使用 person 类 —— 这不是 B2 微调权重）",
                    label,
                    self.class_count,
                )
            else:
                LOGGER.info("检测权重已加载：%s（无法识别类别数）", label)
            return

        raise WeightsMissingError("检测权重不可用")

    # ------------------------------------------------------------------
    # 图像解码与推理
    # ------------------------------------------------------------------

    def _decode_image(self, image_bytes: bytes) -> Tuple[Image.Image, int, int]:
        """解码 JPG/PNG，返回 RGB 图和原始尺寸。

        先检查 PIL 识别出的格式和像素数，再 convert；避免把 GIF/WebP 或
        上亿像素的图片塞进推理。所有异常都转成不带内容片段的 InvalidImage。
        """

        if not isinstance(image_bytes, (bytes, bytearray)) or not image_bytes:
            raise InvalidImageError("图片为空或无法解码")

        try:
            with Image.open(io.BytesIO(bytes(image_bytes))) as opened:
                image_format = (opened.format or "").upper()
                if image_format not in {"JPEG", "PNG"}:
                    raise InvalidImageError("仅支持 JPG/PNG 图片")

                width, height = opened.size
                if width <= 0 or height <= 0:
                    raise InvalidImageError("图片尺寸非法")
                if width * height > self.max_pixels:
                    raise InvalidImageError("图片像素数超过限制")

                # convert 会真正读取像素；放在 with 内可确保临时文件句柄
                # 在离开作用域后关闭。
                rgb = opened.convert("RGB")
        except InvalidImageError:
            raise
        except (
            UnidentifiedImageError,
            Image.DecompressionBombError,
            OSError,
            ValueError,
            SyntaxError,
        ) as exc:
            raise InvalidImageError("图片为空或无法解码") from exc

        return rgb, width, height

    def _predict(
        self, source: Any
    ) -> List[Tuple[Tuple[float, float, float, float], float]]:
        """对一张图/切片做 person-only 推理，返回像素框与置信度。

        每次都必须带 classes=[PERSON_CLASS_ID]。这样既不会让 car/dog 等
        类别占 max_det，也不会让我们误把非人框计入人数。
        """

        if self._model is None:
            raise WeightsMissingError("检测权重不可用")

        try:
            results = self._model.predict(
                source=source,
                imgsz=self.imgsz,
                conf=self.conf,
                iou=self.iou,
                max_det=self.max_det,
                classes=[PERSON_CLASS_ID],
                device=self.device,
                verbose=False,
            )
        except Exception as exc:  # noqa: BLE001 - 统一转 500，不向调用方泄露细节
            raise DetectorError("模型推理失败") from exc

        detections: List[Tuple[Tuple[float, float, float, float], float]] = []
        for result in results or []:
            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue
            data = getattr(boxes, "data", None)
            if data is None:
                continue
            try:
                rows = data.tolist()
            except AttributeError:
                # 兼容部分导出后端把 boxes.data 返回为普通列表的情况。
                try:
                    rows = [row.tolist() if hasattr(row, "tolist") else row for row in data]
                except TypeError:
                    continue

            for row in rows or []:
                try:
                    if row is None or len(row) < 5:
                        continue
                    if len(row) >= 6:
                        class_id = float(row[5])
                        if not math.isfinite(class_id) or int(round(class_id)) != PERSON_CLASS_ID:
                            continue
                    confidence = float(row[4])
                    coordinates = (float(row[0]), float(row[1]), float(row[2]), float(row[3]))
                except (TypeError, ValueError, OverflowError):
                    continue

                if not math.isfinite(confidence):
                    continue
                confidence = min(max(confidence, 0.0), 1.0)
                if confidence < self.conf:
                    continue
                if not all(math.isfinite(value) for value in coordinates):
                    continue
                detections.append((coordinates, confidence))

        return detections

    def _to_normalized_detections(
        self,
        detections: Iterable[Tuple[Tuple[float, float, float, float], float]],
        offset_x: int,
        offset_y: int,
        image_width: int,
        image_height: int,
    ) -> List[Box]:
        """把一张切片上的像素框转换到整图归一化坐标。"""

        boxes: List[Box] = []
        for coordinates, confidence in detections:
            box = to_normalized(
                coordinates,
                offset_x,
                offset_y,
                image_width,
                image_height,
            )
            if box is None:
                continue
            box["confidence"] = confidence
            boxes.append(box)
        return boxes

    # ------------------------------------------------------------------
    # 对外计数
    # ------------------------------------------------------------------

    def count(self, image_bytes: bytes) -> Dict[str, Any]:
        """对一张图片计数并返回 Node 契约规定的完整结构。"""

        started_at = time.monotonic()
        if self._model is None:
            self.load()

        rgb, image_width, image_height = self._decode_image(image_bytes)

        # 先决定这张图要不要切片。**这是 CloudBase CPU 上最值钱的一个判断**：
        # 切一次就是 4 次推理，而大多数手机照片根本不需要切。
        tiled = should_tile(image_width, image_height, self.imgsz, self.grid, self.tiling_mode)

        if not tiled:
            raw_detections = self._predict(rgb)
            boxes = self._to_normalized_detections(
                raw_detections,
                0,
                0,
                image_width,
                image_height,
            )
            # 同一张整图仍跑 NMS：模型本身已做 NMS，但不同框可能来自
            # 极端近邻，合并后再做一次的成本很低，也更稳。
            boxes = nms(boxes, self.iou)
            boxes = filter_boxes(boxes)
            boxes, truncated = cap_detections(boxes, self.max_det)
        else:
            tiles = plan_tiles(image_width, image_height, self.grid, self.overlap)
            detections_by_tile: List[List[Box]] = []
            for tile in tiles:
                x0, y0, x1, y1 = tile.rect
                if x1 <= x0 or y1 <= y0:
                    # 极端小图 + 大 grid 才会出现；跳过空切片，避免模型
                    # 对 0×0 输入抛错。
                    detections_by_tile.append([])
                    continue

                crop = rgb.crop(tile.rect)
                tile_detections = self._predict(crop)
                detections_by_tile.append(
                    self._to_normalized_detections(
                        tile_detections,
                        x0,
                        y0,
                        image_width,
                        image_height,
                    )
                )

            # merge_tiles 先按 core 中心认领，再跨切片 NMS。认领保证每个
            # 检测框最多属于一个切片，NMS 负责极端近重复。
            boxes = merge_tiles(
                detections_by_tile,
                tiles,
                iou_threshold=self.iou,
            )
            boxes = filter_boxes(boxes)
            boxes, truncated = cap_detections(boxes, self.max_det)

        # 最后再守一次置信度下限，确保即便上游某个张量浮点误差导致
        # 0.349999... 这样的值，也不会违反 Node 的
        # confidenceThreshold <= confidence 断言。
        boxes = [box for box in boxes if box["confidence"] >= self.conf]

        quality = quality_of(boxes, image_width, image_height)
        elapsed_ms = int(round(max(0.0, time.monotonic() - started_at) * 1000))

        return {
            "count": len(boxes),
            "boxes": boxes,
            "model": self.model_name,
            "confidenceThreshold": float(self.conf),
            "estimated": True,
            "truncated": bool(truncated),
            "detector": {
                "weights": self.resolved_weights_name,
                "personOnly": True,
                "classCount": self.class_count,
                "imgsz": int(self.imgsz),
                "tiling": self.tiling_info(tiled),
            },
            "quality": {
                "imageWidth": int(image_width),
                "imageHeight": int(image_height),
                "meanBoxArea": float(quality["meanBoxArea"]),
                "smallBoxRatio": float(quality["smallBoxRatio"]),
                "edgeBoxRatio": float(quality["edgeBoxRatio"]),
                "inferenceMs": int(elapsed_ms),
            },
        }

    # ------------------------------------------------------------------
    # 描述信息
    # ------------------------------------------------------------------

    def tiling_info(self, enabled: Optional[bool] = None) -> Dict[str, Any]:
        """切片参数。

        ``enabled`` 为 None 时报告**配置级别**的能力（给 /model 用）；
        传入布尔值时报告**这一张图实际用没用**（给 /count 用）。
        两者必须区分：配置了 2×2 却对一张 800px 的图整图推理，如果还回
        "grid: 2"，调用方与用户看到的"2×2 切片"就是假的。
        """

        grid_active = self.grid > 1
        tiled = grid_active if enabled is None else bool(enabled and grid_active)
        return {
            "enabled": tiled,
            "grid": int(self.grid) if tiled else 1,
            "overlap": float(self.overlap) if tiled else 0.0,
            "merged": "center-core+nms" if tiled else "none",
            "mode": self.tiling_mode,
            "triggerPx": int(self.imgsz * TILE_TRIGGER_RATIO),
        }

    def describe(self) -> Dict[str, Any]:
        """GET /model 的响应体；weights 只给文件名，不暴露服务器路径。"""

        return {
            "model": self.model_name,
            "weights": self.resolved_weights_name,
            "classes": ["person"],
            "classCount": self.class_count,
            "singleClass": self.class_count == 1,
            "imgsz": int(self.imgsz),
            "confidenceThreshold": float(self.conf),
            "maxDet": int(self.max_det),
            "tiling": self.tiling_info(),
            "device": self.device,
        }
