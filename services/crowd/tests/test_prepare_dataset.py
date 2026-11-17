# -*- coding: utf-8 -*-
"""数据转换器的单测。

重点不是"能跑通"，而是三条会**静默出错**的地方：

1. 用了 `vbox`（可见框）而不是 `fbox`（全身框）—— 训练不报错，模型只是长期少报人；
2. `ignore` 区域被当成正样本 —— 框学得糊，肉眼还看不出来；
3. WiderPerson 的未知 `<name>` 被悄悄丢掉 —— 最后一整类人被当成背景。

这三条都能通过"跑起来了"的检查，所以必须逐条断言。
"""

from __future__ import annotations

import json
import shutil
import sys
import unittest
import uuid
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
TOOLS_DIR = SERVICE_DIR / "tools"
sys.path.insert(0, str(SERVICE_DIR))
sys.path.insert(0, str(TOOLS_DIR))

import prepare_dataset as prep  # noqa: E402

# 临时目录放在**工作区内**的 `.tmp/` 下（该目录已在 .gitignore 里）。
#
# 为什么不用 `TemporaryDirectory`：它的清理路径会先 `os.chmod` 再删除，
# 而受限环境（含本项目的文件沙箱）会拒绝 chmod，于是用例因为**环境权限**
# 而不是转换器被判失败。这里用 mkdtemp + `rmtree(ignore_errors=True)`：
# 能删就删，删不掉也不影响结论，且目录在 gitignore 里。
SCRATCH_ROOT = SERVICE_DIR / ".tmp"


def setUpModule() -> None:
    SCRATCH_ROOT.mkdir(parents=True, exist_ok=True)
    # 上一次运行若因权限没删掉，先尽力清一遍
    for leftover in SCRATCH_ROOT.glob("tmp*"):
        if leftover.is_dir():
            shutil.rmtree(leftover, True)


def odgt_record(entries, image_id="273271,abc"):
    return {"ID": image_id, "gtboxes": entries}


def person(x, y, w, h, ignore=0):
    return {"tag": "person", "fbox": [x, y, w, h], "vbox": [x, y, w / 2, h],
            "hbox": [x, y, w / 3, h / 5], "extra": {"ignore": ignore}}


class OdgtTests(unittest.TestCase):
    def test_bad_lines_are_reported_not_crashing(self) -> None:
        self.assertIsNone(prep.parse_odgt_line(""))
        self.assertIsNone(prep.parse_odgt_line("{not json"))
        self.assertIsNone(prep.parse_odgt_line("[1,2,3]"))
        self.assertEqual(prep.parse_odgt_line('{"ID":"a"}')["ID"], "a")

    def test_uses_full_body_box_not_visible_box(self) -> None:
        boxes, ignored, other = prep.odgt_person_boxes(odgt_record([person(10, 20, 40, 80)]))
        self.assertEqual(ignored, 0)
        self.assertEqual(other, 0)
        # fbox=[x,y,w,h] → xyxy=[10,20,50,100]
        self.assertEqual(boxes, [(10.0, 20.0, 50.0, 100.0)])

    def test_ignore_regions_are_never_supervision(self) -> None:
        boxes, ignored, other = prep.odgt_person_boxes(odgt_record([
            person(0, 0, 10, 10, ignore=1),
            person(20, 20, 10, 10, ignore=0),
        ]))
        self.assertEqual(len(boxes), 1)
        self.assertEqual(ignored, 1)

    def test_non_person_tags_are_counted(self) -> None:
        boxes, ignored, other = prep.odgt_person_boxes(odgt_record([
            {"tag": "mask", "fbox": [0, 0, 5, 5], "extra": {"ignore": 0}},
            {"tag": "person", "fbox": [0, 0, 0, 5], "extra": {"ignore": 0}},
            person(1, 1, 5, 5),
        ]))
        self.assertEqual(len(boxes), 1)
        self.assertEqual(other, 2, "mask 与零宽框都应计入 other，而不是静默丢弃")


class WiderPersonTests(unittest.TestCase):
    """WiderPerson 是**每图一个 txt**，不是 XML。首行 N，之后 class x1 y1 x2 y2。"""

    ANNOTATION = "\n".join([
        "4",
        "1 10 20 50 90",     # 行人
        "2 60 20 90 90",     # 骑行者
        "3 100 30 130 95",   # 部分可见的人
        "4 0 0 5 5",         # ignore 区域
    ])

    def test_parses_declared_count_and_class_histogram(self) -> None:
        parsed = prep.parse_widerperson_annotation(self.ANNOTATION)
        self.assertEqual(parsed["declared"], 4)
        self.assertEqual(len(parsed["boxes"]), 4)
        self.assertEqual(parsed["counts"], {1: 1, 2: 1, 3: 1, 4: 1})
        self.assertEqual([box[4] for box in parsed["boxes"]], [1, 2, 3, 4])

    def test_tolerates_no_header_and_bad_lines(self) -> None:
        # 首行不是数字时，退化为"整份都是数据行"，并记录坏行而不是崩掉
        parsed = prep.parse_widerperson_annotation("垃圾行\n1 10 20 50 90\ntwo 1 2 3 4")
        self.assertIsNone(parsed["declared"])
        self.assertEqual(len(parsed["boxes"]), 1)
        self.assertEqual(parsed["badLines"], 2)

    def test_declared_mismatch_is_reported(self) -> None:
        # 文件被截断（声明 5 行、实际 1 行）不能静默当正常
        parsed = prep.parse_widerperson_annotation("5\n1 10 20 50 90")
        self.assertEqual(parsed["declaredMismatch"], 4)

    def test_empty_text_is_safe(self) -> None:
        parsed = prep.parse_widerperson_annotation("")
        self.assertEqual(parsed["boxes"], [])
        self.assertIsNone(parsed["declared"])


class GeometryTests(unittest.TestCase):
    def test_clip_and_min_side(self) -> None:
        self.assertEqual(prep.clip_box((-10, -10, 50, 50), 100, 100), (0.0, 0.0, 50.0, 50.0))
        self.assertIsNone(prep.clip_box((120, 30, 130, 80), 100, 100))
        self.assertIsNone(prep.clip_box((10, 10, 11, 11), 100, 100))  # 1px 的框是噪声
        self.assertEqual(prep.clip_box((50, 50, 10, 10), 100, 100), (10.0, 10.0, 50.0, 50.0))  # 坐标反了要纠正
        self.assertIsNone(prep.clip_box((float("nan"), 0, 10, 10), 100, 100))
        self.assertIsNone(prep.clip_box((0, 0, 10, 10), 0, 100))  # 图像尺寸非法时不能算出 inf

    def test_yolo_line_is_normalized_center_format(self) -> None:
        line = prep.to_yolo_line((10.0, 20.0, 50.0, 100.0), 200, 200)
        self.assertEqual(line, "0 0.150000 0.300000 0.200000 0.400000")
        self.assertTrue(line.startswith("0 "), "类别号必须是 0（person）")


class SplitTests(unittest.TestCase):
    def test_deterministic_for_same_seed(self) -> None:
        items = list(range(100))
        first = prep.assign_split(items, 0.15, 42)
        second = prep.assign_split(items, 0.15, 42)
        self.assertEqual(first, second)
        self.assertNotEqual(first, prep.assign_split(items, 0.15, 7), "换种子必须换切分")

    def test_both_sides_non_empty_on_realistic_sizes(self) -> None:
        for total in (5, 10, 100, 1000):
            train, val = prep.assign_split(list(range(total)), 0.15, 1)
            self.assertEqual(len(train) + len(val), total)
            self.assertGreaterEqual(len(val), 1)
            self.assertGreaterEqual(len(train), 1)
            self.assertFalse(set(train) & set(val), "验证集不能混进训练集")

    def test_tiny_set_overlaps_on_purpose(self) -> None:
        train, val = prep.assign_split([1, 2, 3], 0.5, 1)
        self.assertEqual(len(train), 3)
        self.assertEqual(len(val), 1, "小于 5 张时只为让训练跑通，val 取自 train 本身")


class BuildDatasetTests(unittest.TestCase):
    """端到端：造一个 CrowdHuman 形状的目录，跑完整的组装。"""

    def _scratch(self) -> Path:
        # ⚠️ 用 mkdir 而不是 mkdtemp：mkdtemp 会以 0o700 建目录，在受限环境
        # （本项目的文件沙箱就是）里，这个目录下的子目录创建会被拒绝（WinError 5）。
        # mkdir 继承父目录的 ACL，测出来的就是转换器本身的行为。
        path = SCRATCH_ROOT / ("case-" + uuid.uuid4().hex[:12])
        path.mkdir(parents=True, exist_ok=True)
        self.addCleanup(shutil.rmtree, path, True)
        return path

    def _make_crowdhuman(self, root: Path) -> None:
        from PIL import Image

        (root / "Images").mkdir(parents=True)
        Image.new("RGB", (640, 480), (200, 200, 200)).save(root / "Images" / "img1.jpg")
        lines = [
            json.dumps(odgt_record([person(10, 20, 100, 200), person(300, 100, 80, 160, ignore=1)], "img1")),
            json.dumps(odgt_record([person(1, 1, 5, 5)], "missing")),
        ]
        (root / "annotation_train.odgt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_end_to_end_writes_yolo_layout_and_yaml(self) -> None:
        tmp = self._scratch()
        source = tmp / "CrowdHuman"
        out = tmp / "out"
        self._make_crowdhuman(source)

        stats = prep.build_dataset({"crowdhuman": str(source), "out": str(out), "valRatio": 0.15, "seed": 42})

        self.assertEqual(stats["total"], 1)
        self.assertEqual(stats["sources"]["crowdhuman"]["boxes"], 1, "ignore=1 的框不能进标签")
        self.assertEqual(stats["sources"]["crowdhuman"]["missingImages"], 1)
        labels = list((out / "labels" / "train").glob("*.txt")) + list((out / "labels" / "val").glob("*.txt"))
        # 小样本时同一张图会同时出现在 train 与 val（见 assign_split），所以按 id 去重再数
        self.assertEqual(len({path.stem for path in labels}), 1)
        content = labels[0].read_text(encoding="utf-8").strip()
        self.assertEqual(len(content.splitlines()), 1)
        self.assertTrue(content.startswith("0 "))
        yaml_text = (out / "person.yaml").read_text(encoding="utf-8")
        self.assertIn("nc: 1", yaml_text)
        self.assertIn("names: [person]", yaml_text)
        self.assertIn("train: images/train", yaml_text)
        self.assertTrue((out / "stats.json").is_file())
        self.assertTrue(stats["overlapSmallSet"], "1 张的冒烟集必须标出重叠")

    def test_self_accepts_presplit_yolo_layout(self) -> None:
        """已切好 train/val 的 YOLO 目录也要能吃（公开镜像大多是这个结构）。

        关键点：`images/train/a.jpg` 与 `images/val/a.jpg` 同名时不能互相覆盖 ——
        以前用 stem 当 id，输出目录会静默少一张图。
        """
        tmp = self._scratch()
        root = tmp / "mirror"
        from PIL import Image

        # 每边 3 张、两边同名（000001..000003）：既测"能吃嵌套结构"，
        # 也测"同名不互相覆盖"。用 ≥5 张是为了避开冒烟集的重叠切分。
        for split in ("train", "val"):
            (root / "images" / split).mkdir(parents=True)
            (root / "labels" / split).mkdir(parents=True)
            for index in range(1, 4):
                name = "%06d" % index
                Image.new("RGB", (320, 240), (120, 120, 120)).save(root / "images" / split / (name + ".jpg"))
                (root / "labels" / split / (name + ".txt")).write_text("0 0.5 0.5 0.2 0.4\n", encoding="utf-8")

        stats = prep.build_dataset({"self": str(root), "out": str(tmp / "out")})
        self.assertEqual(stats["total"], 6, "两张同名图都要保留")
        produced = list((tmp / "out" / "images").rglob("*.jpg"))
        self.assertEqual(len(produced), 6, "输出里不能因为 id 冲突少文件")

    def test_widerperson_keeps_only_pedestrians_and_partially_visible(self) -> None:
        tmp = self._scratch()
        source = tmp / "WiderPerson"
        (source / "Annotations").mkdir(parents=True)
        (source / "Images").mkdir(parents=True)
        from PIL import Image

        Image.new("RGB", (240, 160), (170, 170, 170)).save(source / "Images" / "000001.jpg")
        (source / "Annotations" / "000001.jpg.txt").write_text(
            "5\n"
            "1 10 20 50 90\n"      # 行人 → 学
            "2 60 20 90 90\n"      # 骑行者 → 不学（框裹着车）
            "3 100 30 130 95\n"    # 部分可见 → 学（人群里就是这种）
            "4 0 0 5 5\n"          # ignore
            "5 0 0 10 10\n",       # crowd
            encoding="utf-8")

        stats = prep.build_dataset({"widerperson": str(source), "out": str(tmp / "out")})
        bucket = stats["sources"]["widerperson"]
        self.assertEqual(bucket["boxes"], 2, "只学类别 1 与 3")
        self.assertEqual(bucket["ignored"], 2, "类别 4/5 是 ignore 与 crowd，不能监督")
        self.assertEqual(bucket["otherTags"], 1, "类别 2 骑行者默认不学，但要计数")
        self.assertEqual(stats["widerpersonLabels"], {"1": 1, "2": 1, "3": 1, "4": 1, "5": 1})
        label_file = next((tmp / "out" / "labels").rglob("*.txt"))
        self.assertEqual(len(label_file.read_text(encoding="utf-8").splitlines()), 2)

    def test_self_labels_with_other_classes_are_rejected(self) -> None:
        tmp = self._scratch()
        mine = tmp / "mine"
        (mine / "images").mkdir(parents=True)
        (mine / "labels").mkdir(parents=True)
        from PIL import Image

        Image.new("RGB", (320, 240)).save(mine / "images" / "a.jpg")
        (mine / "labels" / "a.txt").write_text("1 0.5 0.5 0.1 0.1\n", encoding="utf-8")
        with self.assertRaises(SystemExit) as ctx:
            prep.build_dataset({"self": str(mine), "out": str(tmp / "out")})
        self.assertIn("非 person 类号", str(ctx.exception))

    def test_self_negative_sample_without_label_is_allowed(self) -> None:
        tmp = self._scratch()
        mine = tmp / "mine"
        (mine / "images").mkdir(parents=True)
        (mine / "labels").mkdir(parents=True)
        from PIL import Image

        Image.new("RGB", (320, 240)).save(mine / "images" / "empty.jpg")
        stats = prep.build_dataset({"self": str(mine), "out": str(tmp / "out")})
        self.assertEqual(stats["total"], 1)
        self.assertEqual(stats["emptyLabels"], 1, "无人的照片是负样本，不是错误")
        label_file = list((tmp / "out" / "labels").rglob("*.txt"))[0]
        self.assertEqual(label_file.read_text(encoding="utf-8"), "")


class PreflightTests(unittest.TestCase):
    """训练前体检：把"训完才发现"的问题提前到"开训前"。"""

    def _dataset(self) -> Path:
        tmp = SCRATCH_ROOT / ("case-" + uuid.uuid4().hex[:12])
        tmp.mkdir(parents=True, exist_ok=True)
        self.addCleanup(shutil.rmtree, tmp, True)
        source = tmp / "CrowdHuman"
        (source / "Images").mkdir(parents=True)
        import json as _json
        from PIL import Image

        Image.new("RGB", (640, 480), (180, 180, 180)).save(source / "Images" / "img1.jpg")
        lines = [_json.dumps(odgt_record([person(10, 20, 100, 200)], "img1"))]
        (source / "annotation_train.odgt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        out = tmp / "out"
        prep.build_dataset({"crowdhuman": str(source), "out": str(out), "seed": 1})
        return out

    def test_clean_dataset_has_no_warning(self) -> None:
        from train import finetune  # noqa: F401 - 触发路径检查

        out = self._dataset()
        report = finetune.preflight(out / "person.yaml")
        self.assertTrue(report["ok"])
        self.assertEqual(report["splits"]["train"]["images"], 1)
        self.assertEqual(report["splits"]["train"]["badClass"], 0)
        self.assertEqual(report["warnings"], [])

    def test_non_zero_class_is_caught(self) -> None:
        from train import finetune

        out = self._dataset()
        target = next((out / "labels").rglob("*.txt"))
        target.write_text("1 0.5 0.5 0.2 0.2\n", encoding="utf-8")
        report = finetune.preflight(out / "person.yaml")
        self.assertGreater(report["splits"]["train"]["badClass"], 0)
        self.assertTrue(any("静默合并" in warning for warning in report["warnings"]))

    def test_unnormalized_coordinates_are_caught(self) -> None:
        from train import finetune

        out = self._dataset()
        target = next((out / "labels").rglob("*.txt"))
        target.write_text("0 120.5 0.5 0.2 0.2\n", encoding="utf-8")
        report = finetune.preflight(out / "person.yaml")
        self.assertGreater(report["splits"]["train"]["unnormalized"], 0)


if __name__ == "__main__":
    unittest.main()
