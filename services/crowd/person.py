"""人形特化的人群计数几何工具。

这个模块刻意只依赖 Python 标准库：服务里最容易被单测覆盖、也最需要被
反复验证的“切片归属、去重、归一化、质量统计”都在这里完成，而模型推理
依赖 torch/ultralytics，放到 detector.py。这样单元测试不需要安装几个 GB
的深度学习运行时。

框统一使用整图归一化坐标的 dict：

    {"x": 0.1, "y": 0.2, "width": 0.05, "height": 0.1, "confidence": 0.8}

其中 x/y 是左上角，width/height 是宽高。所有函数都会丢弃含 NaN/inf 的框，
避免这些值一路传到 JSON 后让 Node 侧的 Number.isFinite 校验失败。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

# YOLO 的 COCO 预训练权重里 person 固定是第 0 类。服务只接受这一类，
# 自定义 person 权重也必须保持这个类别顺序，否则 classes=[0] 就会选错目标。
PERSON_CLASS_ID = 0

DEFAULT_MIN_SIDE = 0.012
DEFAULT_MIN_AREA = 0.0002
DEFAULT_MAX_ASPECT = 6.0
DEFAULT_SMALL_AREA = 0.004
DEFAULT_EDGE_MARGIN = 0.02
DEFAULT_IOU_THRESHOLD = 0.5

# 切片触发阈值：图片最长边超过 `imgsz × 该比例` 才值得切。
#
# 为什么是 1.5 而不是“一律切”：切片让远处小目标变大，代价是**推理次数按
# grid² 增长**。一张 1080p 的照片缩到 1024 只缩了 1.8 倍，人也还有几十像素高，
# 切成 4 块只是把同样的信息算四遍（CloudBase 上就是 4 倍延迟与费用）。
# 反过来，一张 4000px 的原图缩到 1024 缩了 3.9 倍，远处的人会掉到十几像素，
# 这才是切片真正赚钱的场景。1.5 倍是“下沉超过一档”的经验边界，不是准确率结论。
TILE_TRIGGER_RATIO = 1.5

TILING_MODES = ("auto", "force", "off")

Box = Dict[str, float]
TileRect = Tuple[int, int, int, int]


@dataclass(frozen=True)
class Tile:
    """一个切片及其“认领区域”。

    rect 是喂给模型的像素裁剪区域，core 是该切片在整图中的独占认领区域。
    image_width/image_height 是整图尺寸，因为 owns() 要把归一化框换算回
    像素坐标，必须知道整图大小。overlap 保存参数夹紧后的实际值，便于
    排查配置是否越界。

    附加字段都有默认值，主要是为了 dataclass 可读性；实际推理时一律由
    plan_tiles() 构造，能够保证尺寸信息完整。
    """

    rect: TileRect
    core: TileRect
    image_width: int = 0
    image_height: int = 0
    overlap: float = 0.0


# ---------------------------------------------------------------------------
# 基础清洗
# ---------------------------------------------------------------------------


def _finite_number(value: Any) -> Optional[float]:
    """把任意输入转成有限 float；布尔值不当数字使用。"""

    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _integer(value: Any, default: int) -> int:
    """整数解析失败时用默认值，避免配置/脏数据直接让请求崩掉。"""

    if isinstance(value, bool):
        return default
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _clamp(value: float, low: float, high: float) -> float:
    return min(max(value, low), high)


def _box_or_none(raw: Any) -> Optional[Box]:
    """校验并复制一个框。

    为什么要复制而不是原地修改：这些工具经常被 detector、测试和调用方
    共享使用，静默改写入参会让排错非常困难。缺省 confidence 用 1.0，
    是为了让纯几何测试可以只传 x/y/w/h；真实 detector 一定会用模型分数
    覆盖它。显式传入 NaN/inf 的 confidence 则直接丢弃。
    """

    if not isinstance(raw, dict):
        return None

    x = _finite_number(raw.get("x"))
    y = _finite_number(raw.get("y"))
    width = _finite_number(raw.get("width"))
    height = _finite_number(raw.get("height"))
    confidence = _finite_number(raw.get("confidence", 1.0))
    if x is None or y is None or width is None or height is None or confidence is None:
        return None
    if width <= 0.0 or height <= 0.0:
        return None

    # 置信度属于 [0, 1]；超出范围通常是上游异常，夹紧比把非法值交给
    # Node 更安全，也能保证 NMS 的排序仍然有意义。
    confidence = _clamp(confidence, 0.0, 1.0)
    return {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "confidence": confidence,
    }


def _normalized_center_px(tile: Tile, box: Box) -> Optional[Tuple[float, float]]:
    """把归一化框中心换算到整图像素坐标。图像尺寸为 0 时返回 None。"""

    width = _finite_number(tile.image_width)
    height = _finite_number(tile.image_height)
    if width is None or height is None or width <= 0.0 or height <= 0.0:
        return None

    center_x = (box["x"] + box["width"] / 2.0) * width
    center_y = (box["y"] + box["height"] / 2.0) * height
    if not math.isfinite(center_x) or not math.isfinite(center_y):
        return None
    return center_x, center_y


def _center_owned(tile: Tile, box: Box) -> bool:
    """owns() 的内部版本，假设 box 已经清洗过。"""

    center = _normalized_center_px(tile, box)
    if center is None:
        return False
    center_x, center_y = center
    x0, y0, x1, y1 = tile.core
    if x1 <= x0 or y1 <= y0:
        return False

    # 使用半开区间 [x0, x1) × [y0, y1)：若中心恰好落在两块共享边界，
    # 只由右/下那一块认领。这样归属是一个严格分区，不会出现两边都认领。
    return x0 <= center_x < x1 and y0 <= center_y < y1


# ---------------------------------------------------------------------------
# 人形过滤
# ---------------------------------------------------------------------------


def filter_boxes(
    boxes: Iterable[Any],
    *,
    min_side: float = DEFAULT_MIN_SIDE,
    min_area: float = DEFAULT_MIN_AREA,
    max_aspect: float = DEFAULT_MAX_ASPECT,
) -> List[Box]:
    """过滤不像人、又容易在人群场景被误检的框。

    三个阈值各有目的：

    * min_side：过滤远处噪点和小物件；默认 0.012 是相对整图短边约 1.2%。
    * min_area：短边和长边可能都过关，但总面积仍然很小的细碎框。
    * max_aspect：人通常是纵向矩形；横幅、栏杆、地砖线这类误检往往极扁，
      长宽比上限能挡住它们，避免把背景线条算进人数。
    """

    side_limit = _finite_number(min_side)
    area_limit = _finite_number(min_area)
    aspect_limit = _finite_number(max_aspect)

    minimum_side = 0.0 if side_limit is None else max(0.0, side_limit)
    minimum_area = 0.0 if area_limit is None else max(0.0, area_limit)
    if aspect_limit is None or aspect_limit <= 0.0:
        maximum_aspect = DEFAULT_MAX_ASPECT
    else:
        maximum_aspect = aspect_limit

    kept: List[Box] = []
    if boxes is None:
        return kept
    try:
        iterator = iter(boxes)
    except TypeError:
        return kept

    for raw in iterator:
        box = _box_or_none(raw)
        if box is None:
            continue

        width = box["width"]
        height = box["height"]
        if min(width, height) < minimum_side:
            continue
        if width * height < minimum_area:
            continue

        # width/height 已经保证 > 0，不会除零。
        aspect = max(width / height, height / width)
        if aspect > maximum_aspect:
            continue
        kept.append(box)

    return kept


# ---------------------------------------------------------------------------
# 切片计划与中心点归属
# ---------------------------------------------------------------------------


def plan_tiles(width: int, height: int, grid: int, overlap: float) -> List[Tile]:
    """生成 grid×grid 重叠切片，并给每块划出互不重叠的 core。

    为什么需要 core：重叠切片会让同一群人在多个切片里出现，如果直接合并，
    count 会被放大，这是切片计数最常见、也最隐蔽的错误。这里把整图按
    grid 均分成互不重叠的 base cell，作为每块的 core；检测框中心落在哪个
    core，就只由哪一块认领。图像最外边界的方向不会被裁掉，所以所有 core
    的并集严格覆盖整图。

    切片 rect 在 base cell 基础上向相邻方向各扩展 overlap/2 个 cell 宽度，
    使相邻 rect 的重叠宽度约为 overlap × cell_width，让模型在切片边界仍有
    上下文；这部分扩展只用于“看得更全”，不用于“认领”，因此不会重复计数。

    overlap 会被夹紧到 [0, 0.5]；负数、NaN、inf 都按 0 处理。图像尺寸非正
    时返回空列表，调用方应直接判定图片非法。
    """

    width_px = _integer(width, 0)
    height_px = _integer(height, 0)
    if width_px <= 0 or height_px <= 0:
        return []

    grid_n = _integer(grid, 1)
    if grid_n < 1:
        grid_n = 1

    overlap_value = _finite_number(overlap)
    if overlap_value is None:
        overlap_value = 0.0
    overlap_value = _clamp(overlap_value, 0.0, 0.5)

    # 用整数除法生成边界，保证 core 恰好首尾相接；最后一格显式收在图像
    # 边界，避免浮点舍入把最右/最下一列丢掉。
    edges_x = [(index * width_px) // grid_n for index in range(grid_n)] + [width_px]
    edges_y = [(index * height_px) // grid_n for index in range(grid_n)] + [height_px]

    cell_width = width_px / float(grid_n)
    cell_height = height_px / float(grid_n)
    expand_x = int(round(overlap_value * cell_width * 0.5))
    expand_y = int(round(overlap_value * cell_height * 0.5))

    tiles: List[Tile] = []
    for row in range(grid_n):
        core_y0 = edges_y[row]
        core_y1 = edges_y[row + 1]
        for col in range(grid_n):
            core_x0 = edges_x[col]
            core_x1 = edges_x[col + 1]

            # 只有内部边界才向邻块扩展；最外侧保持 0/width，不越过原图。
            rect_x0 = 0 if col == 0 else max(0, core_x0 - expand_x)
            rect_x1 = width_px if col == grid_n - 1 else min(width_px, core_x1 + expand_x)
            rect_y0 = 0 if row == 0 else max(0, core_y0 - expand_y)
            rect_y1 = height_px if row == grid_n - 1 else min(height_px, core_y1 + expand_y)

            tiles.append(
                Tile(
                    rect=(rect_x0, rect_y0, rect_x1, rect_y1),
                    core=(core_x0, core_y0, core_x1, core_y1),
                    image_width=width_px,
                    image_height=height_px,
                    overlap=overlap_value,
                )
            )

    return tiles


def should_tile(width: int, height: int, imgsz: int, grid: int, mode: str = "auto") -> bool:
    """这张图要不要切片推理。

    三个模式对应三种部署取向：

    * `off`   —— 永不全图切片。**CloudBase CPU 实例只有 1—2 核**，
                如果实测延迟不可接受，这是唯一的止损开关（准确率换延迟）。
    * `force` —— 一律切片。给“确定都是远景人群”的专用入口用（例如景区大图）。
    * `auto`  —— 按 `TILE_TRIGGER_RATIO` 判断：图片最长边超过 imgsz 的 1.5 倍
                才切。**这是默认值**，理由是切片的价值来自“避免大幅下采样”，
                而不是来自“切得越多越准”。

    尺寸/切片数非法时一律返回 False：宁可整图算一次，也不要在坏参数下
    切出一堆 0×0 的空片。
    """

    width_px = _integer(width, 0)
    height_px = _integer(height, 0)
    if width_px <= 0 or height_px <= 0:
        return False

    grid_n = _integer(grid, 1)
    if grid_n <= 1:
        return False

    image_size = _integer(imgsz, 0)
    if image_size <= 0:
        return False

    normalized = (mode or "").strip().lower() if isinstance(mode, str) else "auto"
    if normalized == "off":
        return False
    if normalized == "force":
        return True

    longest = max(width_px, height_px)
    return longest > image_size * TILE_TRIGGER_RATIO


def owns(tile: Tile, box: Any) -> bool:
    """判断归一化框的中心是否落在 tile.core 内。

    这里把中心换回像素坐标再和整数 core 边界比较，而不是比较归一化后的
    core：像素边界是整数，能避免 0.1+0.2 这类浮点误差让接缝点归属漂移。
    整图宽高或 core 面积为 0 时一律不认领，防止坏配置造成“所有框都属于
    所有块”的重复计数。
    """

    if not isinstance(tile, Tile):
        return False
    cleaned = _box_or_none(box)
    if cleaned is None:
        return False
    return _center_owned(tile, cleaned)


# ---------------------------------------------------------------------------
# NMS 与切片合并
# ---------------------------------------------------------------------------


def _iou(first: Box, second: Box) -> float:
    """计算两个归一化框的交并比，退化并集返回 0。"""

    ax1 = first["x"]
    ay1 = first["y"]
    ax2 = ax1 + first["width"]
    ay2 = ay1 + first["height"]
    bx1 = second["x"]
    by1 = second["y"]
    bx2 = bx1 + second["width"]
    by2 = by1 + second["height"]

    inter_width = min(ax2, bx2) - max(ax1, bx1)
    inter_height = min(ay2, by2) - max(ay1, by1)
    if inter_width <= 0.0 or inter_height <= 0.0:
        return 0.0

    intersection = inter_width * inter_height
    area_a = first["width"] * first["height"]
    area_b = second["width"] * second["height"]
    union = area_a + area_b - intersection
    if union <= 0.0:
        return 0.0

    value = intersection / union
    # 极端大的有限输入相乘后可能溢出成 inf，导致 inf/inf 为 NaN；
    # 这种框无法可靠比较，按无重叠处理并交给过滤/截断兜底。
    return value if math.isfinite(value) else 0.0


def nms(boxes: Iterable[Any], iou_threshold: float = DEFAULT_IOU_THRESHOLD) -> List[Box]:
    """类别无关的贪心 NMS，按 confidence 从高到低保留。

    服务只检测 person 一类，所以不需要按类别分组；跨类别 NMS 的前提在这里
    不成立，简单实现反而更不容易错。先保留高分框，再用它与后续框的 IoU
    判断是否抑制，是标准且确定性的贪心策略。
    """

    valid: List[Box] = []
    if boxes is None:
        return valid
    try:
        iterator = iter(boxes)
    except TypeError:
        return valid
    for raw in iterator:
        box = _box_or_none(raw)
        if box is not None:
            valid.append(box)

    threshold = _finite_number(iou_threshold)
    if threshold is None:
        threshold = DEFAULT_IOU_THRESHOLD
    threshold = _clamp(threshold, 0.0, 1.0)

    # Python 排序稳定；同分时保持原顺序，便于复现。
    ordered = sorted(valid, key=lambda item: item["confidence"], reverse=True)
    kept: List[Box] = []
    for candidate in ordered:
        if all(_iou(candidate, chosen) <= threshold for chosen in kept):
            kept.append(candidate)
    return kept


def merge_tiles(
    detections_by_tile: Sequence[Sequence[Any]],
    tiles: Sequence[Tile],
    *,
    iou_threshold: float = DEFAULT_IOU_THRESHOLD,
) -> List[Box]:
    """按 core 归属认领各切片结果，再做一次跨切片 NMS。

    detections_by_tile 必须与 tiles 顺序对齐，每个元素是该切片的归一化
    检测列表。先 owned 再 NMS 的顺序很重要：只有被唯一 core 认领的框才
    有资格进入最终结果，这从集合上保证了不会因为切片重叠而重复计数；随后
    的 NMS 只是额外的保险，用来吞掉同一目标在两个切片中框形状略有差异、
    而中心刚好分属不同 core 的极端情况。
    """

    tile_list = list(tiles) if tiles is not None else []
    if not tile_list:
        return []

    grouped: List[Sequence[Any]] = []
    if isinstance(detections_by_tile, dict):
        # 兼容以 tile 下标为 key 的映射；真实 detector 使用顺序列表。
        for index, tile in enumerate(tile_list):
            group = detections_by_tile.get(index)
            if group is None:
                group = detections_by_tile.get(tile, [])
            grouped.append(group)
    else:
        try:
            grouped = list(detections_by_tile or [])
        except TypeError:
            grouped = []
        if len(grouped) < len(tile_list):
            grouped.extend([[] for _ in range(len(tile_list) - len(grouped))])

    claimed: List[Box] = []
    for tile, raw_group in zip(tile_list, grouped):
        if isinstance(raw_group, dict):
            # 允许调用方为单框切片直接传一个框，减少无谓的一层列表。
            group_iter: Iterable[Any] = (raw_group,)
        else:
            try:
                group_iter = iter(raw_group or [])
            except TypeError:
                continue

        for raw in group_iter:
            box = _box_or_none(raw)
            if box is None:
                continue
            if _center_owned(tile, box):
                claimed.append(box)

    return nms(claimed, iou_threshold)


# ---------------------------------------------------------------------------
# 坐标换算与统计
# ---------------------------------------------------------------------------


def to_normalized(
    xyxy: Sequence[float],
    offset_x: float,
    offset_y: float,
    image_width: int,
    image_height: int,
) -> Optional[Box]:
    """把切片内像素框换算为整图归一化框，并夹紧到合法范围。

    detector 每块都把相对该块左上角的 xyxy 交进来，offset 是该切片在整图
    中的左上角。这里同时处理模型偶发越界框、零尺寸框和浮点边界问题：

    * 坐标夹到 [0, 1]，保证 Node 侧 x>=0、x+width<=1.00001；
    * 宽度/高度至少给到 1 个整图像素对应的归一化值，否则 width>0 的契约
      会在极小框上失败；
    * 返回值带 confidence=1.0 占位，detector 必须用模型分数覆盖它。

    图像尺寸非法或输入含 NaN/inf 时返回 None，让调用方跳过这个框，而不是
    抛异常中断整张图。
    """

    width_px = _finite_number(image_width)
    height_px = _finite_number(image_height)
    if width_px is None or height_px is None or width_px <= 0.0 or height_px <= 0.0:
        return None

    try:
        values = list(xyxy)
    except TypeError:
        return None
    if len(values) < 4:
        return None

    x1_raw = _finite_number(values[0])
    y1_raw = _finite_number(values[1])
    x2_raw = _finite_number(values[2])
    y2_raw = _finite_number(values[3])
    offset_x_value = _finite_number(offset_x)
    offset_y_value = _finite_number(offset_y)
    if (
        x1_raw is None
        or y1_raw is None
        or x2_raw is None
        or y2_raw is None
        or offset_x_value is None
        or offset_y_value is None
    ):
        return None

    left_px = min(x1_raw, x2_raw) + offset_x_value
    right_px = max(x1_raw, x2_raw) + offset_x_value
    top_px = min(y1_raw, y2_raw) + offset_y_value
    bottom_px = max(y1_raw, y2_raw) + offset_y_value
    if not all(math.isfinite(item) for item in (left_px, right_px, top_px, bottom_px)):
        return None

    left = _clamp(left_px / width_px, 0.0, 1.0)
    right = _clamp(right_px / width_px, 0.0, 1.0)
    top = _clamp(top_px / height_px, 0.0, 1.0)
    bottom = _clamp(bottom_px / height_px, 0.0, 1.0)

    def _fit_span(low: float, high: float, minimum: float) -> Tuple[float, float]:
        """返回 (起点, 长度)，长度至少 minimum 且完全落在 [0, 1]。"""

        if high < low:
            low, high = high, low
        length = high - low
        if length < minimum:
            center = (low + high) / 2.0
            length = minimum
            low = center - length / 2.0
            if low < 0.0:
                low = 0.0
            if low + length > 1.0:
                low = 1.0 - length
                if low < 0.0:
                    low = 0.0
        # 正常路径下 high 已经被夹紧，这里仍做一次上限保护。
        if low + length > 1.0:
            low = max(0.0, 1.0 - length)
        return low, length

    min_width = min(1.0, 1.0 / width_px)
    min_height = min(1.0, 1.0 / height_px)
    x, width = _fit_span(left, right, min_width)
    y, height = _fit_span(top, bottom, min_height)

    if not all(math.isfinite(item) for item in (x, y, width, height)):
        return None
    if width <= 0.0 or height <= 0.0:
        return None

    return {
        "x": _clamp(x, 0.0, 1.0),
        "y": _clamp(y, 0.0, 1.0),
        "width": width,
        "height": height,
        "confidence": 1.0,
    }


def quality_of(
    boxes: Iterable[Any],
    image_width: int,
    image_height: int,
    *,
    small_area: float = DEFAULT_SMALL_AREA,
    edge_margin: float = DEFAULT_EDGE_MARGIN,
) -> Dict[str, float]:
    """统计检测质量，供 Node 侧判断图片是否难、结果是否退化。

    这些比例都基于归一化坐标，因此 image_width/height 不进入公式；保留
    尺寸参数是为了和 /count 的 quality 结构一致，也方便以后按像素定义
    小目标阈值。空列表返回全 0，而不是让 Node 收到 NaN。

    * meanBoxArea：平均归一化框面积，可反映人群远近。
    * smallBoxRatio：面积小于 small_area 的框占比。
    * edgeBoxRatio：任一边落在整图边缘 edge_margin 内的框占比，贴边目标
      经常被截断，检测置信度也偏低。
    """

    small_limit = _finite_number(small_area)
    if small_limit is None:
        small_limit = DEFAULT_SMALL_AREA
    small_limit = _clamp(small_limit, 0.0, 1.0)

    edge_limit = _finite_number(edge_margin)
    if edge_limit is None:
        edge_limit = DEFAULT_EDGE_MARGIN
    edge_limit = _clamp(edge_limit, 0.0, 0.5)

    areas: List[float] = []
    small_count = 0
    edge_count = 0

    if boxes is not None:
        try:
            iterator = iter(boxes)
        except TypeError:
            iterator = iter(())
        for raw in iterator:
            box = _box_or_none(raw)
            if box is None:
                continue

            area = box["width"] * box["height"]
            if not math.isfinite(area):
                continue
            area = _clamp(area, 0.0, 1.0)
            areas.append(area)
            if area < small_limit:
                small_count += 1

            x = box["x"]
            y = box["y"]
            right = x + box["width"]
            bottom = y + box["height"]
            if (
                x <= edge_limit
                or y <= edge_limit
                or right >= 1.0 - edge_limit
                or bottom >= 1.0 - edge_limit
            ):
                edge_count += 1

    total = len(areas)
    if total == 0:
        return {
            "meanBoxArea": 0.0,
            "smallBoxRatio": 0.0,
            "edgeBoxRatio": 0.0,
        }

    result = {
        "meanBoxArea": _clamp(sum(areas) / total, 0.0, 1.0),
        "smallBoxRatio": _clamp(small_count / total, 0.0, 1.0),
        "edgeBoxRatio": _clamp(edge_count / total, 0.0, 1.0),
    }
    # 输入框都是有限值，正常情况下一定有限；这里再兜底，避免任何 NaN
    # 进入 Flask 的 JSON。
    for key, value in result.items():
        if not math.isfinite(value):
            result[key] = 0.0
    return result


def cap_detections(boxes: Iterable[Any], max_det: int) -> Tuple[List[Box], bool]:
    """按 confidence 截断到 max_det，并返回是否发生了截断。

    为什么截断要按分数：模型输出过多时，低分框更可能是背景误检；优先保留
    高分框能让 count 和 boxes 保持严格一致，同时尽量不牺牲可信目标。
    未超过上限时保持原顺序，避免无谓地改变调用方看到的框顺序。
    """

    limit = _integer(max_det, 0)
    if limit < 0:
        limit = 0

    valid: List[Box] = []
    if boxes is not None:
        try:
            iterator = iter(boxes)
        except TypeError:
            iterator = iter(())
        for raw in iterator:
            box = _box_or_none(raw)
            if box is not None:
                valid.append(box)

    if len(valid) <= limit:
        return valid, False

    ordered = sorted(valid, key=lambda item: item["confidence"], reverse=True)
    return ordered[:limit], True


def counts_by_threshold(boxes: Iterable[Any], thresholds: Iterable[Any]) -> List[Dict[str, float]]:
    """同一批检测框，在不同 conf 门限下各是多少人。

    **这是标定 conf 时唯一需要的东西**：推理只跑一次（用一个很低的门限，
    例如 0.10），把"门限"挪到后处理里扫。否则扫 9 个阈值就要跑 9 遍模型，
    在 CloudBase 的 CPU 上等于把一次标定做成一整天。

    返回按阈值升序、阈值去重后的 ``[{"threshold": 0.35, "count": 7}, ...]``。
    阈值会被夹到 [0, 1]：0 等于"全部保留"，越界值直接夹紧而不是报错 ——
    标定脚本要能容忍手写的网格。NaN/inf 这类无法比较的值直接丢弃。

    ⚠️ 这里只数框，**不判断哪个阈值更好**。选阈值需要人工标注的真值，
    那一步在 `scripts/crowd-eval.js`（Node 侧唯一一份误差算法）。
    """

    valid: List[Box] = []
    if boxes is not None:
        try:
            iterator = iter(boxes)
        except TypeError:
            iterator = iter(())
        for raw in iterator:
            box = _box_or_none(raw)
            if box is not None:
                valid.append(box)

    cleaned: List[float] = []
    if thresholds is not None:
        try:
            candidates = list(thresholds)
        except TypeError:
            candidates = []
        for raw in candidates:
            value = _finite_number(raw)
            if value is None:
                continue
            cleaned.append(_clamp(value, 0.0, 1.0))

    result: List[Dict[str, float]] = []
    for threshold in sorted(set(cleaned)):
        count = 0
        for box in valid:
            if box["confidence"] >= threshold:
                count += 1
        result.append({"threshold": round(threshold, 4), "count": count})
    return result
