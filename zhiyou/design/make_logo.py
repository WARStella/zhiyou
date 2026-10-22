"""
智游·灵动 —— 小程序头像/Logo 生成脚本

上传规格（微信公众平台）：
  格式：png / bmp / jpeg / jpg / gif
  大小：不超过 2MB
  尺寸：建议 144 × 144 px
  建议 PNG 以保持最佳效果

设计约束（这两条决定成败）：
  1. 小程序头像在微信里可能以**圆形**显示（资料页），也可能是圆角方（列表）。
     所以关键图形必须落在**内切圆安全区**内（半径 = 46% 边长），
     否则圆裁会切掉一角 —— 很多团队的 logo 就是这么废掉的。
  2. 实际显示尺寸常只有 40–72 px，因此**不用光晕、不用细线、不用渐变描边**：
     笔画够粗、节点够大、纯色块。缩小后仍要一眼可辨。

输出（每个方案一套）：
  logo_<X>_144.png          ← 直接上传用。满幅方形，不带烘焙圆角，
                               由微信自己做圆角/圆形遮罩，圆裁方裁都不会出问题
  logo_<X>_144_rounded.png  已烘焙圆角的成品，用于其他需要"画好边框"的场合
  logo_<X>_512.png          母版（答辩材料、海报、PPT 复用）
  logo_<X>_circle.png       圆形裁切预览（自检安全区）
  logo_compare.png          四方案对比图，含 64px 圆形实尺预览

用法：python make_logo.py
"""

import os
import numpy as np
from PIL import Image, ImageDraw

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
SIZE = 512
SS = 4
S = SIZE * SS
SAFE = 0.46

C_DEEP = (11, 60, 110)
C_TEAL = (0, 168, 143)
C_WHITE = (255, 255, 255)
C_ACCENT = (255, 122, 69)

SS_ = lambda v: int(round(v * S))


# ── 基础工具 ──────────────────────────────────────────────

def gradient(size, c1, c2):
    y, x = np.mgrid[0:size, 0:size]
    t = ((x + y) / (2 * size - 2))[..., None]
    arr = np.array(c1)[None, None, :] * (1 - t) + np.array(c2)[None, None, :] * t
    return Image.fromarray(arr.astype(np.uint8), 'RGB')


def bg_layer(size, c1, c2, rounded):
    """rounded=True 时烘焙圆角；False 时满幅铺满（上传用）。"""
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    if rounded:
        m = Image.new('L', (size, size), 0)
        ImageDraw.Draw(m).rounded_rectangle(
            [0, 0, size - 1, size - 1], radius=int(size * 0.235), fill=255
        )
    else:
        m = Image.new('L', (size, size), 255)
    out.paste(gradient(size, c1, c2), (0, 0), m)
    return out


def stroke(draw, pts, color, width, caps=True):
    p = [(SS_(x), SS_(y)) for x, y in pts]
    w = SS_(width)
    draw.line(p, fill=color, width=w, joint='curve')
    if caps:
        r = w / 2.0
        for (x, y) in p:
            draw.ellipse([x - r, y - r, x + r, y + r], fill=color)
    return p


def dot(draw, cx, cy, r, color):
    draw.ellipse([SS_(cx - r), SS_(cy - r), SS_(cx + r), SS_(cy + r)], fill=color)


# ── 方案 A：路径 + 终点集合点 ─────────────────────────────
# 语义：一条会拐弯的行程，终点是大家汇合的集合点。
# 对应产品主线「现场动态调整 + 集合协同」。

def concept_a(rounded):
    img = bg_layer(S, C_DEEP, C_TEAL, rounded)
    ov = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)

    route = [(0.265, 0.660), (0.430, 0.460), (0.600, 0.580), (0.740, 0.390)]
    stroke(d, route, C_WHITE, 0.072)
    for (x, y) in route[:-1]:
        dot(d, x, y, 0.040, C_WHITE)

    ex, ey = route[-1]
    dot(d, ex, ey, 0.112, C_ACCENT)
    dot(d, ex, ey, 0.045, C_WHITE)
    return Image.alpha_composite(img, ov)


# ── 方案 B：定位针 + 针内集合点 ───────────────────────────
# 语义：位置与地点。识别度最高、最"地图应用"，但差异化最弱。

def concept_b(rounded):
    img = bg_layer(S, (16, 42, 76), (24, 110, 130), rounded)
    pin = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pin)

    cx, cy, r = 0.5, 0.455, 0.245
    pd.ellipse([SS_(cx - r), SS_(cy - r), SS_(cx + r), SS_(cy + r)], fill=C_WHITE)
    # 三角顶边正好落在圆的最宽处，接缝最干净
    pd.polygon(
        [(SS_(cx - r), SS_(cy)), (SS_(cx + r), SS_(cy)), (SS_(cx), SS_(cy + r * 1.72))],
        fill=C_WHITE,
    )
    img = Image.alpha_composite(img, pin)

    ov = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    dot(d, cx, cy, 0.125, C_ACCENT)
    dot(d, cx, cy, 0.050, C_WHITE)
    return Image.alpha_composite(img, ov)


# ── 方案 C：Z 字路线标志 ──────────────────────────────────
# 语义：取「智游」首字母 Z，并用终点集合点把字母读成一条路线。
# 注意：起笔处不放彩色点 —— 试过，看起来像笔画上长了个疙瘩，是噪音。

def concept_c(rounded):
    img = bg_layer(S, (12, 46, 92), (0, 150, 168), rounded)
    ov = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)

    x0, x1, ytop, ybot, w = 0.310, 0.690, 0.350, 0.650, 0.086
    stroke(d, [(x0, ytop), (x1, ytop)], C_WHITE, w)
    stroke(d, [(x1, ytop), (x0, ybot)], C_WHITE, w, caps=False)
    stroke(d, [(x0, ybot), (x1, ybot)], C_WHITE, w)

    dot(d, x1, ybot, 0.108, C_ACCENT)
    dot(d, x1, ybot, 0.044, C_WHITE)
    return Image.alpha_composite(img, ov)


# ── 方案 D：成员汇聚到集合点 ──────────────────────────────
# 语义：三名成员从不同方向走向同一个集合点。
# 这是四个方案里唯一直接画「集合」这件事的，与计划书 §6.5 的创新主线最贴。

def concept_d(rounded):
    img = bg_layer(S, (14, 52, 96), (0, 156, 140), rounded)
    ov = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)

    cx, cy, R = 0.500, 0.470, 0.300
    members = [
        (cx + R * np.cos(np.radians(t)), cy + R * np.sin(np.radians(t)))
        for t in (90, 210, 330)          # 三个方向，间隔 120°
    ]
    for (mx, my) in members:
        vx, vy = cx - mx, cy - my
        n = (vx * vx + vy * vy) ** 0.5
        # 线在距中心 0.145 处停住，给集合点留出干净的留白
        stroke(d, [(mx, my), (cx - vx / n * 0.145, cy - vy / n * 0.145)], C_WHITE, 0.062)
        dot(d, mx, my, 0.064, C_WHITE)

    dot(d, cx, cy, 0.118, C_ACCENT)
    dot(d, cx, cy, 0.048, C_WHITE)
    return Image.alpha_composite(img, ov)


# ── 输出 ──────────────────────────────────────────────────

CONCEPTS = {
    'A_route': ('路径 + 终点集合点', concept_a),
    'B_pin': ('定位针 + 针内集合点', concept_b),
    'C_zmark': ('Z 字路线标志', concept_c),
    'D_gather': ('成员汇聚集合点', concept_d),
}


def circular(img):
    m = Image.new('L', (img.width, img.height), 0)
    ImageDraw.Draw(m).ellipse([0, 0, img.width - 1, img.height - 1], fill=255)
    out = Image.new('RGBA', img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), m)
    return out


def main():
    masters_upload, masters_rounded = {}, {}

    for key, (label, fn) in CONCEPTS.items():
        up = fn(False).resize((SIZE, SIZE), Image.Resampling.LANCZOS)
        rd = fn(True).resize((SIZE, SIZE), Image.Resampling.LANCZOS)
        masters_upload[key], masters_rounded[key] = up, rd

        up.resize((144, 144), Image.Resampling.LANCZOS).save(
            os.path.join(OUT_DIR, f'logo_{key}_144.png'))
        rd.resize((144, 144), Image.Resampling.LANCZOS).save(
            os.path.join(OUT_DIR, f'logo_{key}_144_rounded.png'))
        up.save(os.path.join(OUT_DIR, f'logo_{key}_512.png'))
        circular(up).save(os.path.join(OUT_DIR, f'logo_{key}_circle.png'))
        print(f'[{key}] {label}')

    # 对比图：主格用烘焙圆角版（更接近成品观感），
    # 右下角贴 64px 圆形裁切的满幅版 —— 一张图同时检验安全区与缩小可辨性
    cell, pad, top = 256, 18, 10
    sheet = Image.new('RGB', (cell * 2 + pad * 3, (cell + top) * 2 + pad * 3), (245, 246, 248))
    for i, key in enumerate(CONCEPTS):
        r, c = divmod(i, 2)
        x0 = pad + c * (cell + pad)
        y0 = pad + r * (cell + top + pad) + top
        sheet.paste(masters_rounded[key].resize((cell, cell), Image.Resampling.LANCZOS), (x0, y0))
        c64 = circular(masters_upload[key]).resize((64, 64), Image.Resampling.LANCZOS)
        sheet.paste(c64, (x0 + cell - 64 - 10, y0 + cell - 64 - 10), c64)
    sheet.save(os.path.join(OUT_DIR, 'logo_compare.png'))
    print('对比图 → logo_compare.png')


if __name__ == '__main__':
    main()
