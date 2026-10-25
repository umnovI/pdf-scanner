"""Рисует иконки приложения. Нужно: Python 3, Pillow (pip install Pillow)."""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"
BLUE = (31, 111, 235)


def icon(size, maskable=False):
    s = 4  # рисуем крупнее и уменьшаем — так края гладкие
    S = size * s
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if maskable:
        d.rectangle([0, 0, S, S], fill=BLUE)
        k = 0.62
    else:
        d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=BLUE)
        k = 0.74
    w, h = S * k * 0.72, S * k
    x0, y0 = (S - w) / 2, (S - h) / 2
    fold = w * 0.3
    d.polygon([(x0, y0), (x0 + w - fold, y0), (x0 + w, y0 + fold), (x0 + w, y0 + h), (x0, y0 + h)],
              fill=(255, 255, 255))
    d.polygon([(x0 + w - fold, y0), (x0 + w, y0 + fold), (x0 + w - fold, y0 + fold)], fill=(190, 210, 245))
    # строки текста
    lw = h * 0.045
    for i, frac in enumerate([0.62, 0.8, 0.8, 0.5]):
        y = y0 + h * (0.42 + i * 0.12)
        d.rounded_rectangle([x0 + w * 0.15, y, x0 + w * (0.15 + 0.7 * frac), y + lw], radius=lw / 2, fill=BLUE)
    # уголки «сканера»
    c, t, m = S * 0.12, S * 0.025, S * (0.06 if maskable else 0.1)
    if maskable:
        m = S * 0.14
    for cx, cy, sx, sy in [(m, m, 1, 1), (S - m, m, -1, 1), (m, S - m, 1, -1), (S - m, S - m, -1, -1)]:
        d.rectangle([min(cx, cx + sx * c), min(cy, cy + sy * t), max(cx, cx + sx * c), max(cy, cy + sy * t)], fill=(255, 255, 255))
        d.rectangle([min(cx, cx + sx * t), min(cy, cy + sy * c), max(cx, cx + sx * t), max(cy, cy + sy * c)], fill=(255, 255, 255))
    return im.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
icon(192).save(OUT / "icon-192.png")
icon(512).save(OUT / "icon-512.png")
icon(512, maskable=True).save(OUT / "icon-maskable-512.png")
ap = Image.new("RGB", (180, 180), BLUE)
ap.paste(icon(180, maskable=True).convert("RGB"))
ap.save(OUT / "apple-touch-icon.png")
print("ok")
