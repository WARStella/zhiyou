"""生成 tabBar 图标（6 张 PNG）。

为什么需要这个脚本：
  app.json 原本只有 tabBar 文字、没有 iconPath。图标是纯几何线条，
  用脚本生成而不是塞几张来源不明的手绘图，好处是可复现、可改色。

规格（微信 tabBar 建议值）：
  81 × 81 px、PNG、透明背景、单色线条、线宽约 5px。

用法：
  python design/make_tabbar_icons.py
  输出到 miniprogram/assets/tabbar/

⚠️ 颜色改在下面的 INACTIVE / ACTIVE 两行，改完重跑即可，
   不要手工去 P 图 —— 下次重跑会把它覆盖掉。
"""

import math
import os

from PIL import Image, ImageDraw

# 与 app.wxss 的 --ink-400 / --brand-600 保持一致
INACTIVE = (111, 125, 137)   # #6F7D89
ACTIVE = (43, 92, 138)       # #2B5C8A

SIZE = 81          # 最终尺寸
SS = 6             # 超采样倍数（Pillow 不做抗锯齿，靠这个）
VB = 24.0          # 逻辑坐标系边长（照 24×24 的图标网格设计）

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "miniprogram", "assets", "tabbar")

K = SIZE * SS / VB          # 逻辑单位 → 像素
STROKE = 1.9                # 逻辑单位下的线宽（@81px 约 6.4px，显示成 24px 时约 1.9px）


def px(v):
    """逻辑坐标 → 超采样画布像素坐标"""
    return v * K


def stroke_w():
    return max(1, int(round(STROKE * K)))


def bezier(p0, p1, p2, p3, n=80):
    """三次贝塞尔采样。Pillow 没有贝塞尔，自己采样成折线。"""
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        pts.append((px(x), px(y)))
    return pts


def dot(d, cx, cy, r, color):
    d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)], fill=color)


def head(d, cx, cy, r, color):
    """空心圆头（人形头像用描边，和身体线条粗细一致）"""
    d.ellipse([px(cx - r), px(cy - r), px(cx + r), px(cy + r)],
              outline=color, width=stroke_w())


def shoulders(d, cx, apex_y, rx, ry, color):
    """肩膀：只画上半圈椭圆弧。

    ⚠️ 关键是用 apex_y（弧顶）而不是圆心来定位 ——
       圆心写法很容易让弧顶切进头部圆里，图标就糊成一个"蘑菇"。
       这里保证 弧顶 = 头部底 + gap，gap 由调用方控制。"""
    cy = apex_y + ry
    d.arc([px(cx - rx), px(cy - ry), px(cx + rx), px(cy + ry)],
          start=180, end=360, fill=color, width=stroke_w())


def draw_route(color):
    """行程：一条会拐弯的路线 + 两端节点。
    '会拐弯' 是刻意的 —— 这个产品的主线就是现场动态调整。"""
    img = Image.new("RGBA", (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    a, b = (5.2, 6.8), (18.8, 17.2)
    pts = bezier(a, (13.2, 6.8), (10.8, 17.2), b)
    d.line(pts, fill=color, width=stroke_w(), joint="curve")
    # 端点略大于线宽，但不要大成一团
    dot(d, a[0], a[1], 1.95, color)
    dot(d, b[0], b[1], 1.95, color)
    return img


def draw_team(color):
    """队伍：两个人形，前面的略大、后面的偏右上，保持分离不清叠"""
    img = Image.new("RGBA", (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 后面那个（小，偏右上）
    head(d, 17.4, 8.6, 2.15, color)
    shoulders(d, 17.4, 12.0, 4.0, 3.4, color)
    # 前面那个（大，偏左下）
    head(d, 8.0, 8.0, 2.65, color)
    shoulders(d, 8.0, 11.8, 5.2, 4.4, color)
    return img


def draw_me(color):
    """我的：单个人形"""
    img = Image.new("RGBA", (SIZE * SS, SIZE * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    head(d, 12.0, 7.8, 3.15, color)
    shoulders(d, 12.0, 12.5, 6.6, 5.4, color)
    return img


ICONS = {
    "trip": draw_route,
    "team": draw_team,
    "me": draw_me,
}


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, fn in ICONS.items():
        for suffix, color in (("", INACTIVE), ("-active", ACTIVE)):
            big = fn(color)
            small = big.resize((SIZE, SIZE), Image.LANCZOS)
            path = os.path.join(OUT_DIR, f"{name}{suffix}.png")
            small.save(path, "PNG", optimize=True)
            print(f"{os.path.relpath(path)}  {small.size[0]}x{small.size[1]}  {len(open(path,'rb').read())/1024:.1f} KB")


if __name__ == "__main__":
    main()
