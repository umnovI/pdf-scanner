"""Рисует тестовые PDF для tests/fixtures/pdf (проверка разбора, объединения и сжатия).

Нужно: Python 3, reportlab, pikepdf, Pillow, numpy
(pip install reportlab pikepdf Pillow numpy).
Запуск: python3 tools/make_pdf_fixtures.py
Результат детерминирован (кроме зашифрованных файлов — у них случайные соли).
Файлы маленькие — их коммитят в репозиторий.

Метки: в каждой странице напечатана строка-метка (TEXT-P1, LINK-P3, IMG-P2…), по ней
тесты узнают страницу. Что внутри каждого файла — в MANIFEST внизу (пишется в manifest.json).
"""
import base64
import io
import json
import re
from pathlib import Path

import numpy as np
import pikepdf
from pikepdf import Array, Dictionary, Name, Pdf
from PIL import Image
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "pdf"
OUT.mkdir(parents=True, exist_ok=True)
SIZES = [(595, 842), (612, 792), (595, 420)]  # A4, Letter, A5 альбомная
rng = np.random.default_rng(20240607)
MANIFEST = {}


def put(name, data, **info):
    (OUT / name).write_bytes(data)
    MANIFEST[name] = info


def save(pdf, name, **kw):
    buf = io.BytesIO()
    pdf.save(buf, deterministic_id=True, **kw)
    return buf.getvalue()


# ---------- Текстовый PDF (reportlab: потоки ASCII85+Flate, шрифт Helvetica) ----------

def make_text():
    buf = io.BytesIO()
    c = canvas.Canvas(buf, invariant=True)  # invariant — без дат и случайных идентификаторов
    c.setTitle("text fixture")
    for i, (w, h) in enumerate(SIZES, 1):
        c.setPageSize((w, h))
        c.setFont("Helvetica", 20)
        c.drawString(50, h - 80, f"TEXT-P{i}")
        c.rect(40, 40, w - 80, h - 160)
        c.showPage()
    c.save()
    return buf.getvalue()


TEXT = make_text()
put("text.pdf", TEXT, pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"], mediaBoxes=[[0, 0, w, h] for w, h in SIZES])


def reopen(data=TEXT, **kw):
    return Pdf.open(io.BytesIO(data), **kw)


# ---------- Те же страницы, другая упаковка ----------
buf = io.BytesIO(); p = reopen(); p.save(buf, object_stream_mode=pikepdf.ObjectStreamMode.generate, deterministic_id=True)
put("objstm.pdf", buf.getvalue(), pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"], note="объектные потоки + xref-поток")

buf = io.BytesIO(); p = reopen(); p.save(buf, linearize=True, deterministic_id=True)
put("linearized.pdf", buf.getvalue(), pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"], note="линеаризованный")

# ---------- Инкрементальное обновление: новая ревизия ставит /Rotate 90 первой странице ----------
p = reopen()
page1 = p.pages[0]
num, gen = page1.objgen
new_page = Dictionary({k: v for k, v in page1.items()})
new_page.Rotate = 90
body = new_page.unparse().decode("latin1")
prev = int(re.search(rb"startxref\s+(\d+)\s+%%EOF\s*$", TEXT).group(1))
root = p.trailer.Root.objgen
size = int(p.trailer.Size)
off = len(TEXT) + 1
inc = bytearray(TEXT) + b"\n"
inc += f"{num} {gen} obj\n{body}\nendobj\n".encode("latin1")
xoff = len(inc)
inc += (f"xref\n{num} 1\n{off:010d} {gen:05d} n \n"
        f"trailer\n<< /Size {size} /Root {root[0]} {root[1]} R /Prev {prev} >>\nstartxref\n{xoff}\n%%EOF\n").encode("latin1")
put("incremental.pdf", bytes(inc), pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"], rotates=[90, 0, 0],
    note="/Prev: у первой страницы /Rotate 90 из новой ревизии (в старой 0)")

# ---------- Повреждения ----------
bad = re.sub(rb"startxref\s+\d+", b"startxref\n99999999", TEXT)
put("bad-startxref.pdf", bad, pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"], note="startxref за пределами файла")

nl = TEXT.index(b"\n") + 1
shifted = TEXT[:nl] + b"%% junk after the header shifts every xref offset\n" + TEXT[nl:]
put("shifted.pdf", shifted, pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"], note="лишние байты после заголовка: смещения xref неверны")

put("junk-prefix.pdf", b"GARBAGE-BEFORE-HEADER\r\n" + TEXT, pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"], note="мусор перед %PDF-")

trunc_at = TEXT.rindex(b"xref\n0 ")
put("truncated.pdf", TEXT[:trunc_at], pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"], note="обрезан: нет xref и trailer")

# ---------- Шифрование (пустой пароль пользователя) ----------
buf = io.BytesIO(); reopen().save(buf, encryption=pikepdf.Encryption(user="", owner="owner", R=4), static_id=True)
put("encrypted.pdf", buf.getvalue(), encrypted=True)
buf = io.BytesIO(); reopen().save(buf, encryption=pikepdf.Encryption(user="", owner="owner", R=6),
                                  object_stream_mode=pikepdf.ObjectStreamMode.generate, static_id=True)
put("encrypted-objstm.pdf", buf.getvalue(), encrypted=True, note="AES-256 + xref-поток")

# ---------- Наследование из /Pages ----------
p = reopen()
pages_node = p.Root.Pages
kids = list(pages_node.Kids)  # обращаться к p.pages нельзя: pikepdf сам «разворачивает» наследование
pages_node.Resources = kids[0].Resources
pages_node.MediaBox = Array([0, 0, 300, 400])
pages_node.Rotate = 180
for pg in kids:
    for k in ("/Resources", "/MediaBox", "/Rotate"):
        if k in pg:
            del pg[k]
# вторая страница переопределяет своё
kids[1].MediaBox = Array([0, 0, 200, 100])
kids[1].Rotate = 90
buf = io.BytesIO(); p.save(buf, deterministic_id=True)
put("inherited.pdf", buf.getvalue(), pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"],
    mediaBoxes=[[0, 0, 300, 400], [0, 0, 200, 100], [0, 0, 300, 400]], rotates=[180, 90, 180],
    note="Resources/MediaBox/Rotate лежат в /Pages; у страницы 2 свои MediaBox и Rotate")

# ---------- Ссылки между страницами, закладки ----------
p = reopen()
pg = p.pages
link_dest = p.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array([40, 700, 200, 740]),
                                       Border=Array([0, 0, 0]), Dest=Array([pg[2].obj, Name.Fit]), P=pg[0].obj))
link_goto = p.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Link, Rect=Array([40, 640, 200, 680]),
                                       Border=Array([0, 0, 0]), P=pg[0].obj,
                                       A=Dictionary(S=Name.GoTo, D=Array([pg[1].obj, Name.Fit]))))
pg[0].Annots = Array([link_dest, link_goto])
outl_item = p.make_indirect(Dictionary(Title=pikepdf.String("Закладка"), Dest=Array([pg[2].obj, Name.Fit])))
p.Root.Outlines = p.make_indirect(Dictionary(Type=Name.Outlines, First=outl_item, Last=outl_item, Count=1))
outl_item.Parent = p.Root.Outlines
buf = io.BytesIO(); p.save(buf, deterministic_id=True)
put("link.pdf", buf.getvalue(), pages=3, marks=["TEXT-P1", "TEXT-P2", "TEXT-P3"],
    note="страница 1: ссылка /Dest на страницу 3 и /A GoTo на страницу 2; есть закладки")

# ---------- Гибридный файл: таблица + /XRefStm ----------
import zlib


def hybrid(mark_free):
    objs = {}
    content = b"BT /F1 20 Tf 50 400 Td (HYB-P1) Tj ET"
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"           # обычный
    objs[4] = b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream"
    members = {2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>"}
    head, body, pos = b"", b"", []
    for n, v in members.items():
        head += b"%d %d " % (n, len(body)); body += v + b"\n"
    data = zlib.compress(head + body)
    objs[5] = b"<< /Type /ObjStm /N 2 /First %d /Filter /FlateDecode /Length %d >>\nstream\n" % (len(head), len(data)) + data + b"\nendstream"
    out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    offs = {}
    for n in (1, 4, 5):
        offs[n] = len(out)
        out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
    # поток xref: объекты 2 и 3 — в потоке 5 (тип 2)
    rows = b""
    for n in (2, 3):
        rows += bytes([2]) + (5).to_bytes(2, "big") + bytes([n - 2])
    xs_off = len(out)
    xs = zlib.compress(rows)
    out += (b"6 0 obj\n<< /Type /XRef /Size 7 /W [1 2 1] /Index [2 2] /Filter /FlateDecode /Length %d >>\nstream\n" % len(xs)) + xs + b"\nendstream\nendobj\n"
    xoff = len(out)
    out += b"xref\n"
    if mark_free:
        out += b"0 7\n0000000000 65535 f \n%010d 00000 n \n0000000000 00000 f \n0000000000 00000 f \n%010d 00000 n \n%010d 00000 n \n%010d 00000 n \n" % (
            offs[1], offs[4], offs[5], xs_off)
    else:
        out += b"0 2\n0000000000 65535 f \n%010d 00000 n \n4 3\n%010d 00000 n \n%010d 00000 n \n%010d 00000 n \n" % (offs[1], offs[4], offs[5], xs_off)
    out += b"trailer\n<< /Size 7 /Root 1 0 R /XRefStm %d >>\nstartxref\n%d\n%%%%EOF\n" % (xs_off, xoff)
    return bytes(out)


put("hybrid.pdf", hybrid(False), pages=1, marks=["HYB-P1"], mediaBoxes=[[0, 0, 400, 500]],
    note="гибридный: объектов потока в таблице нет, они описаны в /XRefStm")

# ---------- Картинки ----------

def noisy(w, h, amp=40, seed=0):
    r = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w]
    base = np.stack([x * 255 // w, y * 255 // h, (x + y) * 255 // (w + h)], axis=-1).astype(np.int16)
    return np.clip(base + r.integers(-amp, amp + 1, base.shape), 0, 255).astype(np.uint8)


def jpeg_bytes(arr, mode=None, q=92):
    b = io.BytesIO()
    Image.fromarray(arr, mode).save(b, "JPEG", quality=q)
    return b.getvalue()


def img_pdf():
    p = Pdf.new()
    font = p.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica))
    pages = []

    def add_page(n, img):
        p.add_blank_page(page_size=(595, 842))
        pg = p.pages[-1]
        pg.Resources = Dictionary(XObject=Dictionary(Im0=img), Font=Dictionary(F1=font))
        pg.Contents = p.make_stream(f"q 400 0 0 400 50 300 cm /Im0 Do Q BT /F1 24 Tf 50 780 Td (IMG-P{n}) Tj ET".encode())

    def image(data, w, h, cs, bpc=8, **filters):
        s = p.make_stream(data)
        s.Type = Name.XObject; s.Subtype = Name.Image; s.Width = w; s.Height = h
        if cs is not None:
            s.ColorSpace = cs
        s.BitsPerComponent = bpc
        for k, v in filters.items():
            setattr(s, k, v)
        return s

    # 1: ASCII85 + DCT, RGB (как делает reportlab)
    jp = jpeg_bytes(noisy(256, 256))
    add_page(1, image(base64.a85encode(jp) + b"~>", 256, 256, Name.DeviceRGB, Filter=Array([Name.ASCII85Decode, Name.DCTDecode])))
    # 2: Flate RGB
    rgb = noisy(160, 160, 12, seed=2)
    add_page(2, image(zlib.compress(rgb.tobytes(), 6), 160, 160, Name.DeviceRGB, Filter=Name.FlateDecode))
    # 3: Gray Flate с PNG-предиктором (Up)
    g = noisy(220, 220, 20, seed=3)[:, :, 0]
    rows = bytearray()
    prev = np.zeros(220, np.uint8)
    for row in g:
        rows.append(2); rows += ((row.astype(np.int16) - prev.astype(np.int16)) & 255).astype(np.uint8).tobytes(); prev = row
    add_page(3, image(zlib.compress(bytes(rows), 6), 220, 220, Name.DeviceGray, Filter=Name.FlateDecode,
                      DecodeParms=Dictionary(Predictor=15, Colors=1, BitsPerComponent=8, Columns=220)))
    # 4: RGB с маской прозрачности SMask (градиент) — маска не должна ни стать JPEG, ни пропасть
    rgb = noisy(160, 160, 12, seed=4)
    alpha = np.tile(np.linspace(0, 255, 160).astype(np.uint8), (160, 1))
    alpha = np.clip(alpha.astype(np.int16) + np.random.default_rng(5).integers(-20, 21, alpha.shape), 0, 255).astype(np.uint8)
    sm = image(zlib.compress(alpha.tobytes(), 6), 160, 160, Name.DeviceGray, Filter=Name.FlateDecode)
    im = image(zlib.compress(rgb.tobytes(), 6), 160, 160, Name.DeviceRGB, Filter=Name.FlateDecode)
    im.SMask = sm
    add_page(4, im)
    # 5: CMYK JPEG — не трогается
    cmyk = np.concatenate([noisy(200, 200, 30, seed=6), noisy(200, 200, 30, seed=7)[:, :, :1]], axis=-1)
    add_page(5, image(jpeg_bytes(cmyk, "CMYK"), 200, 200, Name.DeviceCMYK, Filter=Name.DCTDecode,
                      Decode=Array([1, 0, 1, 0, 1, 0, 1, 0])))
    # 6: JPEG в градациях серого (один канал)
    gray_jp = jpeg_bytes(noisy(240, 240, 35, seed=8)[:, :, 0], "L")
    add_page(6, image(gray_jp, 240, 240, Name.DeviceGray, Filter=Name.DCTDecode))
    # 7: Flate RGB в ICCBased (N=3) с настоящим профилем sRGB
    from PIL import ImageCms
    icc = p.make_stream(ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes())
    icc.N = 3
    icc.Alternate = Name.DeviceRGB
    rgb = noisy(160, 160, 12, seed=9)
    add_page(7, image(zlib.compress(rgb.tobytes(), 6), 160, 160, Array([Name.ICCBased, icc]), Filter=Name.FlateDecode))
    # 8: маленькая картинка (меньше 16 КБ) — не трогается
    small = noisy(40, 40, 60, seed=10)
    add_page(8, image(zlib.compress(small.tobytes(), 6), 40, 40, Name.DeviceRGB, Filter=Name.FlateDecode))
    # 9: штриховая маска ImageMask (1 бит) — не трогается
    bits = np.packbits(np.random.default_rng(11).integers(0, 2, (400, 400)).astype(np.uint8), axis=1)
    im9 = image(zlib.compress(bits.tobytes(), 6), 400, 400, None, bpc=1, Filter=Name.FlateDecode)
    im9.ImageMask = True
    add_page(9, im9)
    # 10: Indexed (палитра) — не трогается
    idx = np.random.default_rng(12).integers(0, 256, (160, 160)).astype(np.uint8)
    pal = bytes(np.random.default_rng(13).integers(0, 256, 768).astype(np.uint8))
    add_page(10, image(zlib.compress(idx.tobytes(), 6), 160, 160, Array([Name.Indexed, Name.DeviceRGB, 255, pikepdf.String(pal)]), Filter=Name.FlateDecode))
    # 11: RGB с цветовой маской /Mask [r r g g b b] (ключ цвета) — после JPEG ключ перестаёт совпадать
    rgb = noisy(160, 160, 12, seed=14)
    rgb[:40, :40] = (255, 0, 255)
    im11 = image(zlib.compress(rgb.tobytes(), 6), 160, 160, Name.DeviceRGB, Filter=Name.FlateDecode)
    im11.Mask = Array([255, 255, 0, 0, 255, 255])
    add_page(11, im11)
    b = io.BytesIO(); p.save(b, deterministic_id=True)
    return b.getvalue()


put("images.pdf", img_pdf(), pages=11, marks=[f"IMG-P{i}" for i in range(1, 12)],
    images={"1": "ASCII85+DCT RGB", "2": "Flate RGB", "3": "Flate Gray + PNG-предиктор", "4": "Flate RGB + SMask", "5": "CMYK DCT (+Decode)",
            "6": "DCT Gray", "7": "Flate ICCBased N=3", "8": "малая картинка", "9": "ImageMask", "10": "Indexed", "11": "Flate RGB + цветовая маска /Mask [..]"})


# ---------- Одна страница с одним JPEG: EXIF-поворот и «уже сильно сжатый» JPEG ----------

def one_jpeg_pdf(jpeg, w, h, mark):
    p = Pdf.new()
    p.add_blank_page(page_size=(595, 842))
    pg = p.pages[-1]
    im = p.make_stream(jpeg)
    im.Type = Name.XObject; im.Subtype = Name.Image; im.Width = w; im.Height = h
    im.ColorSpace = Name.DeviceRGB; im.BitsPerComponent = 8; im.Filter = Name.DCTDecode
    font = p.make_indirect(Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica))
    pg.Resources = Dictionary(XObject=Dictionary(Im0=im), Font=Dictionary(F1=font))
    pg.Contents = p.make_stream(f"q 400 0 0 600 50 150 cm /Im0 Do Q BT /F1 24 Tf 50 780 Td ({mark}) Tj ET".encode())
    b = io.BytesIO(); p.save(b, deterministic_id=True)
    return b.getvalue()


# JPEG 400x600 (в самих пикселях), в EXIF Orientation=6: просмотрщики PDF поворот не применяют
exif = Image.Exif()
exif[0x0112] = 6
buf = io.BytesIO()
Image.fromarray(noisy(400, 600, 50, seed=21)).save(buf, "JPEG", quality=85, exif=exif)
put("exif.pdf", one_jpeg_pdf(buf.getvalue(), 400, 600, "EXIF-P1"), pages=1, marks=["EXIF-P1"],
    note="JPEG 400x600 с EXIF Orientation=6; PDF-просмотрщики поворот игнорируют")

# JPEG, который уже сжат сильнее любого уровня сжатия приложения (качество 3, шумная картинка)
buf = io.BytesIO()
Image.fromarray(noisy(1600, 1200, 120, seed=22)).save(buf, "JPEG", quality=3)
put("lowq.pdf", one_jpeg_pdf(buf.getvalue(), 1600, 1200, "LOWQ-P1"), pages=1, marks=["LOWQ-P1"],
    note="JPEG качества 3: перекодирование на высоких уровнях делало бы его больше")

(OUT / "manifest.json").write_text(json.dumps(MANIFEST, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
total = sum(f.stat().st_size for f in OUT.glob("*.pdf"))
print(f"{len(MANIFEST)} файлов, {total / 1024:.0f} КБ")
