# -*- coding: utf-8 -*-
"""detector 的元信息：**B2 到底做完没有**只能靠这里验证。

背景：`classes=[0]` 让 80 类的官方权重和 1 类的微调权重在输出上**完全一样**，
都是"只有 person 的框"。也就是说，把官方 yolo11n.pt 改名成 person.pt，
服务照样跑、契约照样过、日志照样"已加载权重"。唯一能区分的数是类别数。

这个文件只测 `_class_count` 与 `/model` 的描述，不加载任何真实权重，
因此不需要 torch/ultralytics。
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SYS_PATH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SYS_PATH))

import detector  # noqa: E402


class FakeInner:
    def __init__(self, names=None, nc=None):
        if names is not None:
            self.names = names
        if nc is not None:
            self.nc = nc


class FakeModel:
    def __init__(self, inner=None, names=None):
        if inner is not None:
            self.model = inner
        if names is not None:
            self.names = names


class ClassCountTests(unittest.TestCase):
    def test_coco_names_dict_is_80(self) -> None:
        names = {index: "c%d" % index for index in range(80)}
        self.assertEqual(detector._class_count(FakeModel(FakeInner(names=names))), 80)

    def test_single_class_is_1(self) -> None:
        self.assertEqual(detector._class_count(FakeModel(FakeInner(names={0: "person"}))), 1)
        self.assertEqual(detector._class_count(FakeModel(FakeInner(names=["person"]))), 1)

    def test_falls_back_to_nc(self) -> None:
        self.assertEqual(detector._class_count(FakeModel(FakeInner(nc=80))), 80)

    def test_model_level_names_are_used(self) -> None:
        # 有些导出后端把 names 挂在 YOLO 对象上，而不是 model.model 上
        self.assertEqual(detector._class_count(FakeModel(names=["person"])), 1)

    def test_unknown_returns_none_instead_of_guessing(self) -> None:
        # 取不到就是 unknown —— 不能默认成 1，否则"B2 已完成"变成一句空话
        self.assertIsNone(detector._class_count(FakeModel()))
        self.assertIsNone(detector._class_count(None))
        self.assertIsNone(detector._class_count(FakeModel(FakeInner(names={}))))
        self.assertIsNone(detector._class_count(FakeModel(FakeInner(names=[], nc=0))))


class DescribeTests(unittest.TestCase):
    def test_describe_reports_class_count_truthfully(self) -> None:
        default = detector.PersonDetector(weights="person.pt", model_name="yolo11n-person")
        body = default.describe()
        self.assertIsNone(body["classCount"], "没加载权重时类别数必须是 unknown")
        self.assertFalse(body["singleClass"])
        self.assertEqual(body["classes"], ["person"], "只取 person 类这件事与权重类别数无关")

        default.class_count = 1
        self.assertTrue(default.describe()["singleClass"])
        default.class_count = 80
        self.assertFalse(default.describe()["singleClass"], "80 类权重不能自称单类")


if __name__ == "__main__":
    unittest.main()
