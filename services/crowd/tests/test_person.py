"""person.py 的纯标准库单元测试。

原则：只 import person，绝不伪造 torch，也不 import detector/app。这样
这些几何逻辑可以在没有模型、没有网络的机器上反复跑。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

# `python -m unittest discover -s tests` 从 crowd/ 启动，正常情况下 crowd/
# 已在 sys.path 中；显式补一次路径，避免不同调用方式下找不到 person。
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import person  # noqa: E402


def make_box(
    x: float = 0.2,
    y: float = 0.2,
    width: float = 0.1,
    height: float = 0.2,
    confidence: float = 0.9,
) -> dict:
    return {
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "confidence": confidence,
    }


def rect_area(rect: tuple) -> int:
    x0, y0, x1, y1 = rect
    return max(0, x1 - x0) * max(0, y1 - y0)


class FilterBoxesTests(unittest.TestCase):
    def test_keeps_normal_person_shape(self) -> None:
        """正常竖直人形应原样保留，且输出只含标准字段。"""
        box = make_box(0.3, 0.2, 0.1, 0.3, 0.87)
        result = person.filter_boxes([box])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0], box)

    def test_rejects_too_small_side_and_area(self) -> None:
        """短边过小或面积过小的框都不算可信人形。"""
        too_thin = make_box(0.1, 0.1, 0.005, 0.2)
        too_small_area = make_box(0.2, 0.2, 0.015, 0.012)
        normal = make_box(0.3, 0.3, 0.08, 0.2)
        result = person.filter_boxes([too_thin, too_small_area, normal])
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["x"], normal["x"])

    def test_rejects_flat_and_vertical_stripes(self) -> None:
        """横幅和竖条的长宽比过大，是典型背景误检。"""
        flat = make_box(0.1, 0.1, 0.6, 0.08)
        vertical = make_box(0.1, 0.1, 0.08, 0.6)
        self.assertEqual(person.filter_boxes([flat, vertical]), [])

    def test_drops_non_finite_boxes(self) -> None:
        """含 NaN/inf 的坐标或置信度必须直接丢弃。"""
        boxes = [
            make_box(x=float("nan")),
            make_box(width=float("inf")),
            make_box(confidence=float("nan")),
            make_box(confidence=float("inf")),
            make_box(0.4, 0.4, 0.05, 0.2, 0.8),
        ]
        result = person.filter_boxes(boxes)
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(result[0]["x"], 0.4)

    def test_empty_input(self) -> None:
        self.assertEqual(person.filter_boxes([]), [])
        self.assertEqual(person.filter_boxes(None), [])


class PlanTilesTests(unittest.TestCase):
    def test_single_tile_is_whole_image(self) -> None:
        """1×1 时 rect 与 core 都必须是完整原图。"""
        tiles = person.plan_tiles(640, 480, 1, 0.3)
        self.assertEqual(len(tiles), 1)
        tile = tiles[0]
        self.assertEqual(tile.rect, (0, 0, 640, 480))
        self.assertEqual(tile.core, (0, 0, 640, 480))
        self.assertEqual(tile.image_width, 640)
        self.assertEqual(tile.image_height, 480)
        self.assertAlmostEqual(tile.overlap, 0.3)

    def test_two_by_two_cores_partition_image(self) -> None:
        """2×2 的 core 必须互不重叠，并集覆盖整图；rect 合法且包含 core。"""
        width, height = 1000, 800
        tiles = person.plan_tiles(width, height, 2, 0.2)
        self.assertEqual(len(tiles), 4)

        for tile in tiles:
            rx0, ry0, rx1, ry1 = tile.rect
            cx0, cy0, cx1, cy1 = tile.core
            self.assertGreaterEqual(rx0, 0)
            self.assertGreaterEqual(ry0, 0)
            self.assertLessEqual(rx1, width)
            self.assertLessEqual(ry1, height)
            self.assertLess(rx0, rx1)
            self.assertLess(ry0, ry1)
            self.assertLessEqual(rx0, cx0)
            self.assertLessEqual(ry0, cy0)
            self.assertLessEqual(cx1, rx1)
            self.assertLessEqual(cy1, ry1)

        for index, first in enumerate(tiles):
            for second in tiles[index + 1 :]:
                ax0, ay0, ax1, ay1 = first.core
                bx0, by0, bx1, by1 = second.core
                overlap_w = max(0, min(ax1, bx1) - max(ax0, bx0))
                overlap_h = max(0, min(ay1, by1) - max(ay0, by0))
                self.assertEqual(overlap_w * overlap_h, 0)

        self.assertEqual(sum(rect_area(tile.core) for tile in tiles), width * height)

        # 相邻 rect 应当真的有 overlap，否则切片边界没有上下文。
        left = min(tiles, key=lambda item: item.core[0] + item.core[1])
        right = next(tile for tile in tiles if tile.core[0] > left.core[0])
        self.assertGreater(min(left.rect[2], right.rect[2]) - max(left.rect[0], right.rect[0]), 0)

        top = min(tiles, key=lambda item: item.core[0] + item.core[1])
        bottom = next(tile for tile in tiles if tile.core[1] > top.core[1])
        self.assertGreater(min(top.rect[3], bottom.rect[3]) - max(top.rect[1], bottom.rect[1]), 0)

    def test_clamps_overlap_out_of_range(self) -> None:
        """overlap 超界要夹到 [0, 0.5]，而不是产生负重叠或越界裁剪。"""
        high = person.plan_tiles(100, 100, 2, 9.0)
        self.assertTrue(high)
        self.assertTrue(all(tile.overlap == 0.5 for tile in high))
        self.assertTrue(all(0 <= tile.rect[0] < tile.rect[2] <= 100 for tile in high))
        self.assertTrue(all(0 <= tile.rect[1] < tile.rect[3] <= 100 for tile in high))

        low = person.plan_tiles(100, 100, 2, -3)
        self.assertTrue(low)
        self.assertTrue(all(tile.overlap == 0.0 for tile in low))
        self.assertTrue(all(tile.rect == tile.core for tile in low))

        nan_plan = person.plan_tiles(100, 100, 2, float("nan"))
        self.assertTrue(all(tile.overlap == 0.0 for tile in nan_plan))

    def test_invalid_dimensions_and_grid(self) -> None:
        self.assertEqual(person.plan_tiles(0, 100, 2, 0.2), [])
        self.assertEqual(person.plan_tiles(100, -1, 2, 0.2), [])
        # grid < 1 视作 1；这是防御性行为，正常配置不会走到。
        self.assertEqual(len(person.plan_tiles(100, 100, 0, 0.2)), 1)


class OwnershipTests(unittest.TestCase):
    def test_center_ownership_is_unique_at_seam(self) -> None:
        """中心恰在切片缝上时，只能由一个 core 认领。"""
        tiles = person.plan_tiles(100, 100, 2, 0.2)
        # 中心正好在 (50, 25)，即左右两块的共享竖缝上。
        seam_box = make_box(0.45, 0.20, 0.10, 0.10)
        owners = [tile for tile in tiles if person.owns(tile, seam_box)]
        self.assertEqual(len(owners), 1)
        # row-major：右上角那块 core 是 [50,100)×[0,50)。
        self.assertEqual(owners[0].core, (50, 0, 100, 50))

        left_box = make_box(0.39, 0.20, 0.10, 0.10)
        right_box = make_box(0.56, 0.20, 0.10, 0.10)
        left_owners = [tile for tile in tiles if person.owns(tile, left_box)]
        right_owners = [tile for tile in tiles if person.owns(tile, right_box)]
        self.assertEqual(len(left_owners), 1)
        self.assertEqual(len(right_owners), 1)
        self.assertEqual(left_owners[0].core, (0, 0, 50, 50))
        self.assertEqual(right_owners[0].core, (50, 0, 100, 50))

    def test_merge_counts_seam_person_only_once(self) -> None:
        """构造所有切片都出同一个缝上人形框，合并后仍只能算 1 人。"""
        tiles = person.plan_tiles(100, 100, 2, 0.2)
        seam_box = make_box(0.45, 0.20, 0.10, 0.10, 0.88)
        detections = [[dict(seam_box)] for _ in tiles]

        merged = person.merge_tiles(detections, tiles, iou_threshold=0.5)
        self.assertEqual(len(merged), 1)
        self.assertEqual(len(merged), int(len(merged)))
        self.assertAlmostEqual(merged[0]["confidence"], 0.88)

    def test_merge_count_matches_boxes(self) -> None:
        """两个互不重叠的人分别归属不同切片，合并后 count 必须为 2。"""
        tiles = person.plan_tiles(100, 100, 2, 0.2)
        first = make_box(0.2, 0.2, 0.1, 0.2, 0.9)
        second = make_box(0.7, 0.7, 0.1, 0.2, 0.8)
        # 每个切片都输出两个框，验证 owned 之后再合并的计数一致性。
        merged = person.merge_tiles([list((first, second)) for _ in tiles], tiles)
        self.assertEqual(len(merged), 2)
        self.assertEqual(len(merged), int(len(merged)))


class NmsTests(unittest.TestCase):
    def test_fully_contained_box_is_suppressed(self) -> None:
        """低分大框完全包住高分小框时，应按 IoU 抑制低分框。"""
        big = make_box(0.1, 0.1, 0.6, 0.6, 0.7)
        small = make_box(0.2, 0.2, 0.2, 0.2, 0.9)
        kept = person.nms([big, small], 0.1)
        self.assertEqual(len(kept), 1)
        self.assertAlmostEqual(kept[0]["confidence"], 0.9)

    def test_partial_overlap_threshold(self) -> None:
        """部分重叠时，阈值决定保留一个还是两个。"""
        first = make_box(0.1, 0.1, 0.4, 0.4, 0.9)
        second = make_box(0.3, 0.1, 0.4, 0.4, 0.8)
        self.assertEqual(len(person.nms([first, second], 0.3)), 1)
        self.assertEqual(len(person.nms([first, second], 0.5)), 2)

    def test_disjoint_boxes_both_kept(self) -> None:
        first = make_box(0.05, 0.05, 0.2, 0.2, 0.9)
        second = make_box(0.6, 0.6, 0.2, 0.2, 0.8)
        self.assertEqual(len(person.nms([first, second], 0.1)), 2)


class ToNormalizedTests(unittest.TestCase):
    def test_offset_and_scale(self) -> None:
        """切片偏移必须叠加到像素坐标，再按整图尺寸归一化。"""
        box = person.to_normalized((10, 20, 110, 220), 20, 10, 200, 400)
        self.assertIsNotNone(box)
        assert box is not None
        self.assertAlmostEqual(box["x"], 0.15)
        self.assertAlmostEqual(box["y"], 0.075)
        self.assertAlmostEqual(box["width"], 0.5)
        self.assertAlmostEqual(box["height"], 0.5)

    def test_clamps_outside_coordinates(self) -> None:
        """模型越界框要夹回整图，避免 Node 断言 x+width<=1 失败。"""
        box = person.to_normalized((-50, -50, 300, 500), 0, 0, 100, 200)
        self.assertIsNotNone(box)
        assert box is not None
        self.assertEqual(box["x"], 0.0)
        self.assertEqual(box["y"], 0.0)
        self.assertEqual(box["width"], 1.0)
        self.assertEqual(box["height"], 1.0)

    def test_zero_size_box_gets_pixel_floor(self) -> None:
        """零尺寸框不能产出 width=0；要退化为至少 1 像素的宽高。"""
        box = person.to_normalized((2000, 1000, 2000, 1000), 0, 0, 1000, 500)
        self.assertIsNotNone(box)
        assert box is not None
        self.assertGreater(box["width"], 0.0)
        self.assertGreater(box["height"], 0.0)
        self.assertGreaterEqual(box["x"], 0.0)
        self.assertGreaterEqual(box["y"], 0.0)
        self.assertLessEqual(box["x"] + box["width"], 1.0 + 1e-12)
        self.assertLessEqual(box["y"] + box["height"], 1.0 + 1e-12)

    def test_invalid_image_dimensions_return_none(self) -> None:
        self.assertIsNone(person.to_normalized((1, 2, 3, 4), 0, 0, 0, 100))
        self.assertIsNone(person.to_normalized((1, 2, 3, 4), 0, 0, 100, 0))


class QualityTests(unittest.TestCase):
    def test_empty_boxes_return_zeroes(self) -> None:
        quality = person.quality_of([], 1920, 1080)
        self.assertEqual(
            quality,
            {"meanBoxArea": 0.0, "smallBoxRatio": 0.0, "edgeBoxRatio": 0.0},
        )

    def test_all_small_boxes(self) -> None:
        boxes = [
            make_box(0.3, 0.3, 0.03, 0.03, 0.8),
            make_box(0.5, 0.5, 0.03, 0.03, 0.8),
            make_box(0.7, 0.7, 0.03, 0.03, 0.8),
        ]
        quality = person.quality_of(boxes, 1920, 1080)
        self.assertAlmostEqual(quality["meanBoxArea"], 0.0009)
        self.assertEqual(quality["smallBoxRatio"], 1.0)
        self.assertEqual(quality["edgeBoxRatio"], 0.0)

    def test_edge_boxes(self) -> None:
        boxes = [
            make_box(0.0, 0.4, 0.1, 0.2),
            make_box(0.85, 0.4, 0.15, 0.2),
            make_box(0.2, 0.45, 0.1, 0.2),
        ]
        quality = person.quality_of(boxes, 1920, 1080)
        self.assertAlmostEqual(quality["edgeBoxRatio"], 2.0 / 3.0)
        self.assertEqual(quality["smallBoxRatio"], 0.0)


class CapDetectionsTests(unittest.TestCase):
    def test_truncates_by_confidence(self) -> None:
        boxes = [
            make_box(0.1, 0.1, 0.1, 0.2, 0.2),
            make_box(0.2, 0.1, 0.1, 0.2, 0.6),
            make_box(0.3, 0.1, 0.1, 0.2, 0.4),
            make_box(0.4, 0.1, 0.1, 0.2, 0.5),
        ]
        kept, truncated = person.cap_detections(boxes, 2)
        self.assertTrue(truncated)
        self.assertEqual(len(kept), 2)
        self.assertEqual([box["confidence"] for box in kept], [0.6, 0.5])

    def test_not_truncated_at_or_below_limit(self) -> None:
        boxes = [
            make_box(0.1, 0.1, 0.1, 0.2, 0.2),
            make_box(0.2, 0.1, 0.1, 0.2, 0.6),
        ]
        kept, truncated = person.cap_detections(boxes, 3)
        self.assertFalse(truncated)
        self.assertEqual([box["confidence"] for box in kept], [0.2, 0.6])

        kept_zero, truncated_zero = person.cap_detections(boxes, 0)
        self.assertTrue(truncated_zero)
        self.assertEqual(kept_zero, [])


class ShouldTileTests(unittest.TestCase):
    """切片触发条件：这是 CloudBase CPU 上延迟与召回之间唯一的开关。"""

    def test_auto_tiles_only_when_image_is_much_larger_than_input(self) -> None:
        # 4:3 的手机原图（12MP）缩到 1024 要缩 3.9 倍，远处的人会掉到十几像素
        self.assertTrue(person.should_tile(4032, 3024, 1024, 2, "auto"))
        # 1920 长边缩 1.875 倍，超过 1.5 的触发线
        self.assertTrue(person.should_tile(1920, 1080, 1024, 2, "auto"))
        # 1440 长边只缩 1.4 倍，切了也是把同样的信息算四遍
        self.assertFalse(person.should_tile(1440, 1080, 1024, 2, "auto"))
        self.assertFalse(person.should_tile(800, 600, 1024, 2, "auto"))

    def test_force_and_off_override_the_heuristic(self) -> None:
        self.assertTrue(person.should_tile(400, 400, 1024, 2, "force"))
        self.assertFalse(person.should_tile(6000, 4000, 1024, 2, "off"))

    def test_bad_input_never_tiles(self) -> None:
        self.assertFalse(person.should_tile(0, 1080, 1024, 2, "auto"))
        self.assertFalse(person.should_tile(-1, 1080, 1024, 2, "auto"))
        self.assertFalse(person.should_tile(4000, 3000, 1024, 1, "force"))
        self.assertFalse(person.should_tile(4000, 3000, 0, 2, "auto"))
        # 未知模式按 auto 处理，而不是抛错或一律切片
        self.assertTrue(person.should_tile(4000, 3000, 1024, 2, "whatever"))

    def test_threshold_is_derived_from_imgsz(self) -> None:
        # imgsz 变小意味着下采样更狠，触发线也应随之下降
        self.assertFalse(person.should_tile(1000, 800, 1024, 2, "auto"))
        self.assertTrue(person.should_tile(1000, 800, 640, 2, "auto"))


class CountsByThresholdTests(unittest.TestCase):
    """标定 conf 的口径：同一批框、不同门限，各数出几个人。"""

    def test_counts_drop_as_threshold_rises(self) -> None:
        boxes = [
            make_box(0.1, 0.1, 0.1, 0.2, 0.25),
            make_box(0.3, 0.1, 0.1, 0.2, 0.45),
            make_box(0.5, 0.1, 0.1, 0.2, 0.80),
        ]
        rows = person.counts_by_threshold(boxes, [0.2, 0.4, 0.9])
        self.assertEqual([row["threshold"] for row in rows], [0.2, 0.4, 0.9])
        self.assertEqual([row["count"] for row in rows], [3, 2, 0])

    def test_boundary_is_inclusive(self) -> None:
        # 门限与置信度相等时必须算“保留”，否则标定表在界点会莫名少一人
        boxes = [make_box(0.1, 0.1, 0.1, 0.2, 0.35)]
        self.assertEqual(person.counts_by_threshold(boxes, [0.35])[0]["count"], 1)

    def test_sorts_and_dedupes_thresholds(self) -> None:
        boxes = [make_box(0.1, 0.1, 0.1, 0.2, 0.5)]
        rows = person.counts_by_threshold(boxes, [0.5, 0.2, 0.5])
        self.assertEqual([row["threshold"] for row in rows], [0.2, 0.5])

    def test_out_of_range_is_clamped_and_nan_dropped(self) -> None:
        boxes = [make_box(0.1, 0.1, 0.1, 0.2, 0.5)]
        rows = person.counts_by_threshold(boxes, [-1, 1.5, float("nan"), None])
        self.assertEqual([row["threshold"] for row in rows], [0.0, 1.0])
        # 0 等于全部保留；1.0 谁都过不了（置信度被夹到 <= 1 但 0.5 < 1）
        self.assertEqual([row["count"] for row in rows], [1, 0])

    def test_empty_inputs_are_safe(self) -> None:
        self.assertEqual(person.counts_by_threshold([], [0.3]), [{"threshold": 0.3, "count": 0}])
        self.assertEqual(person.counts_by_threshold(None, None), [])
        # 坏框不能把整张表带崩
        rows = person.counts_by_threshold([{"x": float("nan"), "y": 0, "width": 1, "height": 1, "confidence": 0.9}], [0.3])
        self.assertEqual(rows[0]["count"], 0)


if __name__ == "__main__":
    unittest.main()
