from PIL import Image

SRC = r'design\preview\trip-full.png'
OUT_LONG = r'design\preview\trip-page.png'
OUT_WRAP = r'design\preview\preview.png'

im = Image.open(SRC).convert('RGB')
w, h = im.size

# 1) 裁掉底部空白：背景是缓慢变化的渐变，用「与上方 60px 同列像素比」找内容末行
px = im.load()
bottom = h
for y in range(h - 6, 200, -1):
    hits = 0
    for x in range(12, w - 12, 12):
        r, g, b = px[x, y]
        r2, g2, b2 = px[x, max(0, y - 60)]
        if abs(r - r2) + abs(g - g2) + abs(b - b2) > 24:
            hits += 1
    if hits > 6:
        bottom = min(h, y + 90)
        break
im = im.crop((0, 0, w, bottom))
im.save(OUT_LONG)

# 2) 两列折行（长图在聊天/预览里更好读），与确认图的排版一致
gap = 40
margin = 32
half = min(im.height - 200, max(1200, int(im.height * 0.465)))
left = im.crop((0, 0, w, half))
right = im.crop((0, half, w, im.height))
sheet_h = max(left.height, right.height) + margin * 2
sheet = Image.new('RGB', (margin * 2 + w * 2 + gap, sheet_h), (255, 255, 255))
sheet.paste(left, (margin, margin))
sheet.paste(right, (margin + w + gap, margin))
sheet.save(OUT_WRAP)
print('long', im.size, '->', OUT_LONG)
print('wrap', sheet.size, '->', OUT_WRAP)
