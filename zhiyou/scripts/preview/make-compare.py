from PIL import Image, ImageDraw, ImageFont

CONF = r'C:\Users\欢实的黄鳝\Desktop\传智杯\media\sha256_0f86e74c9a99c49fcaa677d56da9ac2cb40058a8a53cdc704595d844da39bf06.png'
NOW = r'design\preview\trip-screen.png'
OUT = r'design\preview\compare.png'

def font(size, bold=False):
    for p in (r'C:\Windows\Fonts\msyhbd.ttc' if bold else r'C:\Windows\Fonts\msyh.ttc',
              r'C:\Windows\Fonts\msyh.ttc'):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            pass
    return ImageFont.load_default()

H = 1180
a = Image.open(CONF).convert('RGB').crop((0, 0, 640, 1250))   # 确认图的左栏 = 手机首屏
b = Image.open(NOW).convert('RGB')                            # 现在代码的首屏

def fit(im, h):
    w = round(im.width * h / im.height)
    return im.resize((w, h), Image.LANCZOS)

a2, b2 = fit(a, H), fit(b, H)
pad, gap, top = 28, 40, 64
W = pad * 2 + a2.width + gap + b2.width
sheet = Image.new('RGB', (W, H + top + pad), (247, 249, 252))
sheet.paste(a2, (pad, top))
sheet.paste(b2, (pad + a2.width + gap, top))
d = ImageDraw.Draw(sheet)
f = font(24, True)
d.text((pad, 18), '会话里确认的版本', font=f, fill=(27, 58, 92))
d.text((pad + a2.width + gap, 18), '现在代码渲染（同一屏）', font=f, fill=(27, 58, 92))
sheet.save(OUT)
print(sheet.size, OUT)
