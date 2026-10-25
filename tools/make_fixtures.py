"""Рисует тестовые «фото документов» для tests/fixtures.

Нужно: Python 3, Pillow, numpy (pip install Pillow numpy).
Запуск: python3 tools/make_fixtures.py
Углы листа на каждом снимке записываются в tests/fixtures/truth.json
(в пикселях, порядок TL, TR, BR, BL).
"""
import json
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
W, H = 1000, 1250  # размер кадра
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


if not Path(FONT).is_file():
    # Без этого шрифта подписи на фото получились бы другими (а кириллица — «квадратиками»).
    raise SystemExit(f"Не найден шрифт DejaVu Sans: {FONT}\n"
                     "Установите его (Debian/Ubuntu: apt install fonts-dejavu-core) и запустите скрипт снова.")


@lru_cache(maxsize=None)
def font(size):
    return ImageFont.truetype(FONT, size)


def coeffs(dst, src):
    a, b = [], []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    return np.linalg.solve(np.array(a, float), np.array(b, float)).tolist()


def text_lines(d, n=18, y0=110, col=(30, 30, 30), size=17):
    for i in range(n):
        d.text((45, y0 + i * 30), f"Строка текста документа номер {i}", fill=col, font=font(size))


def place(doc, bg, quad, shadow=0.0, tint=None, extra=None):
    img = Image.new("RGB", (W, H), bg)
    if extra:
        extra(ImageDraw.Draw(img))
    dw, dh = doc.size
    warped = doc.transform((W, H), Image.PERSPECTIVE, coeffs(quad, [(0, 0), (dw, 0), (dw, dh), (0, dh)]), Image.BICUBIC)
    m = Image.new("L", (W, H), 0)
    ImageDraw.Draw(m).polygon(quad, fill=255)
    img.paste(warped, (0, 0), m)
    if shadow:
        g = Image.linear_gradient("L").rotate(90).resize((W, H)).point(lambda v: int(v * shadow))
        img = Image.composite(Image.new("RGB", (W, H), (0, 0, 0)), img, g)
    if tint:
        a = np.asarray(img).astype(float) * np.array(tint)
        img = Image.fromarray(a.clip(0, 255).astype("uint8"))
    return img


def sheet(color=(248, 248, 245)):
    return Image.new("RGB", (600, 850), color)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    truth = {}

    def save(name, img, quad):
        img.save(OUT / name, quality=85)
        truth[name] = [list(p) for p in quad]

    q = [(190, 160), (840, 210), (800, 1110), (150, 1060)]

    d = sheet(); text_lines(ImageDraw.Draw(d))
    save("white.jpg", place(d, (90, 70, 55), q, shadow=0.35), q)

    d = sheet((245, 222, 120)); dd = ImageDraw.Draw(d)
    dd.rectangle([20, 20, 580, 830], outline=(180, 40, 40), width=8)
    dd.text((150, 120), "ГРАМОТА", fill=(170, 30, 30), font=font(60))
    text_lines(dd, 6, 300)
    dd.ellipse([380, 620, 520, 760], outline=(30, 60, 170), width=6)
    save("yellow.jpg", place(d, (150, 145, 140), q, shadow=0.4), q)

    d = sheet((250, 250, 252)); dd = ImageDraw.Draw(d)
    for x in range(0, 600, 18): dd.line([(x, 0), (x, 850)], fill=(170, 200, 230))
    for y in range(0, 850, 18): dd.line([(0, y), (600, y)], fill=(170, 200, 230))
    text_lines(dd, 12, 60, (30, 40, 150), 22)
    save("school.jpg", place(d, (160, 110, 70), q), q)

    r = [(500, 90), (910, 500), (500, 1160), (90, 750)]
    d = sheet(); text_lines(ImageDraw.Draw(d))
    save("rot45.jpg", place(d, (70, 75, 80), r), r)

    d = sheet(); dd = ImageDraw.Draw(d); dd.rectangle([40, 50, 560, 450], fill=(25, 30, 35)); text_lines(dd, 10, 480)
    save("darkphoto.jpg", place(d, (110, 90, 70), q), q)

    d = sheet(); dd = ImageDraw.Draw(d); dd.rectangle([30, 30, 570, 270], fill=(40, 90, 200)); text_lines(dd, 14, 320)
    save("header.jpg", place(d, (120, 120, 120), q, extra=lambda e: e.rectangle([860, 300, 990, 820], fill=(200, 30, 40))), q)

    d = Image.new("RGB", (600, 850), (250, 250, 250)); text_lines(ImageDraw.Draw(d))
    save("warm.jpg", place(d, (60, 60, 60), q, tint=(1.0, 0.9, 0.72)), q)

    # Грамота с широкой тёмной узорной рамкой на тёмном фоне (баг: рамка
    # находилась по светлой середине, а не по краю листа).
    rng = np.random.default_rng(7)
    g = Image.new("RGB", (600, 850), (232, 232, 228))          # светлая кромка листа
    dd = ImageDraw.Draw(g)
    dd.rectangle([14, 14, 586, 836], fill=(105, 92, 95))       # розовато-серая сетка
    for k in range(14, 586, 9):
        dd.line([(k, 14), (k + 60, 836)], fill=(150, 120, 125), width=1)
        dd.line([(k + 60, 14), (k, 836)], fill=(150, 120, 125), width=1)
    for _ in range(700):                                        # тёмно-зелёные завитки
        x, y = rng.integers(14, 586), rng.integers(14, 836)
        rr = int(rng.integers(8, 30))
        dd.ellipse([x - rr, y - rr, x + rr, y + rr], outline=(25, 70, 50), width=int(rng.integers(3, 8)))
    dd.rectangle([95, 110, 505, 740], fill=(246, 246, 244))   # белое поле
    dd.text((150, 170), "ПОХВАЛЬНАЯ", fill=(190, 30, 35), font=font(44))
    dd.text((165, 225), "ГРАМОТА", fill=(190, 30, 35), font=font(56))
    text_lines(dd, 8, 360)
    def carbon(e):                                              # тёмный фон с текстурой
        for y in range(0, H, 6):
            e.line([(0, y), (W, y + 40)], fill=(38, 38, 42), width=2)
    gq = [(120, 110), (880, 125), (870, 1150), (130, 1140)]
    img = place(g, (22, 22, 25), gq, extra=carbon)
    a = np.asarray(img).astype(float)
    a[:, 600:] *= np.linspace(1.0, 1.25, W - 600)[None, :, None]  # блик справа
    save("ornate.jpg", Image.fromarray(a.clip(0, 255).astype("uint8")), gq)

    # Свет пятном (ярко в центре, темнее к краям).
    d = sheet(); text_lines(ImageDraw.Draw(d))
    img = place(d, (90, 70, 55), q)
    yy, xx = np.mgrid[0:H, 0:W]
    r = np.hypot(xx - W / 2, yy - H / 2) / np.hypot(W / 2, H / 2)
    a = np.asarray(img).astype(float) * (1.6 - 0.8 * r)[..., None]
    save("radial.jpg", Image.fromarray(a.clip(0, 255).astype("uint8")), q)

    # Ручка касается листа.
    d = sheet(); text_lines(ImageDraw.Draw(d))
    img = place(d, (120, 120, 120), q)
    ImageDraw.Draw(img).rectangle([820, 600, 990, 640], fill=(20, 20, 160))
    save("pen.jpg", img, q)

    # Низкий контраст: белый лист на светло-сером столе.
    d = sheet(); text_lines(ImageDraw.Draw(d))
    save("lowcontrast.jpg", place(d, (215, 215, 212), q, shadow=0.2), q)

    # Тёмная тень на столе вплотную к листу.
    d = sheet(); text_lines(ImageDraw.Draw(d))
    save("castshadow.jpg", place(d, (150, 130, 110), q,
         extra=lambda e: e.polygon([(840, 210), (900, 240), (860, 1140), (800, 1110)], fill=(70, 60, 50))), q)
    # Размытый снимок с шумом матрицы (для проверки чёткости текста).
    from PIL import ImageFilter
    d = sheet(); text_lines(ImageDraw.Draw(d), 22, 60, (35, 35, 35), 15)
    rng = np.random.default_rng(1)
    b = place(d, (90, 70, 55), q).filter(ImageFilter.GaussianBlur(1.4))
    a = np.asarray(b).astype(float) + rng.normal(0, 3.0, (H, W, 1))
    save("blurry.jpg", Image.fromarray(a.clip(0, 255).astype("uint8")), q)

    # Альбомное фото (без листа) — для проверки одинакового размера страниц PDF.
    Image.new("RGB", (1200, 800), (40, 120, 60)).save(OUT / "landscape.jpg", quality=85)

    (OUT / "truth.json").write_text(json.dumps(truth, indent=1, ensure_ascii=False))
    print("ok", len(truth))


if __name__ == "__main__":
    main()
