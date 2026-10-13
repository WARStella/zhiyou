"""
生成地图标记图标。

为什么需要：微信小程序 `map` 组件的 `markers[].iconPath` 是**必填**的，
没有图标文件标记不会渲染。所以这几个小图是页面能跑起来的前提。

输出到 ../miniprogram/assets/
  pin-place.png    未去的景点（蓝）
  pin-done.png     已到过的景点（绿）—— 游玩过程中一眼看出走到哪了
  pin-meeting.png  集合点（橙，稍大）
  dot-me.png       我的位置（绿点，带白描边）
"""

import os
import numpy as np
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'miniprogram', 'assets')
os.makedirs(OUT, exist_ok=True)

SS = 4  # 超采样倍率（Pillow 不做抗锯齿）


def pin(w, h, color, dot_color=(255, 255, 255)):
    """水滴形定位针：上圆下方尖。"""
    W, H = w * SS, h * SS
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    r = W * 0.46
    cx, cy = W / 2, r + W * 0.04
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    d.polygon(
        [(cx - r * 0.92, cy + r * 0.30), (cx + r * 0.92, cy + r * 0.30), (cx, H - W * 0.03)],
        fill=color,
    )

    # 内部圆点（集合点用同心圆强调）
    dr = r * 0.40
    d.ellipse([cx - dr, cy - dr, cx + dr, cy + dr], fill=dot_color)

    return img.resize((w, h), Image.Resampling.LANCZOS)


def ring(w, color, core=(255, 255, 255), ring_w=0.16):
    """带白圈的实心圆点（我的位置）。"""
    W = w * SS
    img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = W * 0.06
    d.ellipse([pad, pad, W - pad, W - pad], fill=core)
    inner = W * (0.5 - ring_w) - pad * 0.5
    c = W / 2
    d.ellipse([c - inner, c - inner, c + inner, c + inner], fill=color)

    return img.resize((w, w), Image.Resampling.LANCZOS)


def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path)
    print(f'  {name}  {img.size[0]}x{img.size[1]}')


print('生成地图标记图标：')
save(pin(32, 40, (11, 60, 110)), 'pin-place.png')        # 深蓝：未去
save(pin(32, 40, (15, 157, 88)), 'pin-done.png')         # 绿：已到过
save(pin(34, 42, (255, 122, 69)), 'pin-meeting.png')     # 橙：集合点
save(ring(26, (15, 157, 88)), 'dot-me.png')              # 绿：我的位置
print('完成 → miniprogram/assets/')
