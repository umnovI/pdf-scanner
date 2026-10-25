// Модуль pdf.js: разбор JPEG и сборка PDF.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { inApp, launch, parsePdf, startServer, unitPage } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

/** Собирает PDF из JPEG заданных размеров [[w, h], …] и возвращает его байты. */
async function build(page, sizes, opts = {}) {
  const b64 = await inApp(page, async ({ pdf, util }, { sizes, opts }) => {
    const jpegs = [];
    for (const [w, h] of sizes) jpegs.push(await util.mkJpeg(w, h));
    return util.b64(await pdf.buildPdf(jpegs, opts));
  }, { sizes, opts });
  return Buffer.from(b64, 'base64');
}

/** Положение картинок на страницах: из потока «q w 0 0 h x y cm». */
const placements = buf => [...buf.toString('latin1').matchAll(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im0 Do Q/g)]
  .map(m => ({ w: +m[1], h: +m[2], x: +m[3], y: +m[4] }));

const titleOf = buf => {
  const hex = /\/Title <([0-9A-F]+)>/.exec(buf.toString('latin1'))[1];
  assert.ok(hex.startsWith('FEFF'), 'заголовок должен начинаться с BOM UTF-16BE');
  return Buffer.from(hex.slice(4), 'hex').swap16().toString('utf16le');
};

describe('jpegInfo', () => {
  test('размеры и число каналов настоящего JPEG', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, async ({ pdf, util }) => {
      const out = [];
      for (const [w, h] of [[123, 45], [1, 1], [640, 480], [45, 123]]) {
        const bytes = new Uint8Array(await (await util.mkJpeg(w, h)).arrayBuffer());
        out.push(pdf.jpegInfo(bytes));
      }
      return out;
    });
    assert.deepEqual(r, [
      { width: 123, height: 45, components: 3 }, { width: 1, height: 1, components: 3 },
      { width: 640, height: 480, components: 3 }, { width: 45, height: 123, components: 3 },
    ]);
  });

  test('1, 3 и 4 канала из заголовка SOF (в том числе после других сегментов)', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ pdf }) => {
      const sof = (marker, h, w, comps) => [0xFF, marker, 0, 8 + 3 * comps, 8, h >> 8, h & 255, w >> 8, w & 255, comps, 0, 0, 0, 0, 0, 0];
      const app0 = [0xFF, 0xE0, 0, 4, 1, 2];            // посторонний сегмент до SOF
      const dht = [0xFF, 0xC4, 0, 4, 9, 9];             // DHT — не SOF, пропускается
      const mk = (...parts) => new Uint8Array([0xFF, 0xD8, ...parts.flat(), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      return [
        pdf.jpegInfo(mk(sof(0xC0, 300, 200, 1))),
        pdf.jpegInfo(mk(app0, sof(0xC0, 300, 200, 3))),
        pdf.jpegInfo(mk(app0, dht, sof(0xC2, 1000, 2000, 4))),   // прогрессивный JPEG
      ];
    });
    assert.deepEqual(r, [
      { width: 200, height: 300, components: 1 },
      { width: 200, height: 300, components: 3 },
      { width: 2000, height: 1000, components: 4 },
    ]);
  });

  test('битые данные дают ошибку, а не мусор', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, async ({ pdf, util }) => {
      const err = bytes => { try { pdf.jpegInfo(bytes); return null; } catch (e) { return e.message; } };
      const good = new Uint8Array(await (await util.mkJpeg(100, 100)).arrayBuffer());
      return {
        empty: err(new Uint8Array(0)),
        png: err(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])),
        onlySoi: err(new Uint8Array([0xFF, 0xD8])),
        cut: err(good.slice(0, 20)),            // оборван до SOF
        text: err(new TextEncoder().encode('это не картинка')),
      };
    });
    assert.equal(r.empty, 'Не JPEG');
    assert.equal(r.png, 'Не JPEG');
    assert.equal(r.text, 'Не JPEG');
    assert.equal(r.onlySoi, 'Повреждённый JPEG');
    assert.equal(r.cut, 'Повреждённый JPEG');
  });

  test('buildPdf отвергает не-JPEG', async () => {
    const { page } = await unitPage(browser, server);
    const msg = await inApp(page, async ({ pdf }) => {
      try { await pdf.buildPdf([new Blob([new Uint8Array(50)])]); return null; } catch (e) { return e.message; }
    });
    assert.equal(msg, 'Не JPEG');
  });
});

describe('buildPdf', () => {
  const A4 = [0, 0, 595.28, 841.89], LETTER = [0, 0, 612, 792];
  const SHAPES = {
    'вертикальное': [300, 400], 'горизонтальное': [400, 300], 'квадрат': [300, 300],
    'узкое вертикальное': [50, 600], 'узкое горизонтальное': [600, 50], 'крошечное': [1, 1],
  };

  test('таблица xref верна, число страниц и размеры картинок совпадают', async () => {
    const { page } = await unitPage(browser, server);
    const sizes = Object.values(SHAPES);
    const pdf = parsePdf(await build(page, sizes));
    assert.deepEqual(pdf.errors, []);
    assert.equal(pdf.count, sizes.length);
    assert.equal(pdf.pages.length, sizes.length);
    assert.deepEqual(pdf.images.map(i => [i.w, i.h]), sizes);
    assert.ok(pdf.images.every(i => i.cs === 'DeviceRGB'));
  });

  for (const [size, dims] of [['a4', A4], ['letter', LETTER]]) {
    for (const fit of ['fit', 'fill']) {
      for (const margin of [0, 18, 36]) {
        test(`все страницы одного размера: ${size}, ${fit}, поля ${margin}`, async () => {
          const { page } = await unitPage(browser, server);
          const sizes = Object.values(SHAPES);
          const buf = await build(page, sizes, { size, fit, margin });
          const pdf = parsePdf(buf);
          assert.deepEqual(pdf.errors, []);
          assert.equal(pdf.pages.length, sizes.length);
          for (const mb of pdf.pages) assert.deepEqual(mb, dims);

          const pl = placements(buf);
          assert.equal(pl.length, sizes.length);
          const eps = 0.02;
          pl.forEach((p, i) => {
            const [iw, ih] = sizes[i];
            // картинка целиком внутри полей
            assert.ok(p.x >= margin - eps && p.y >= margin - eps, `стр. ${i + 1}: вылезла за поле слева/снизу`);
            assert.ok(p.x + p.w <= dims[2] - margin + eps && p.y + p.h <= dims[3] - margin + eps, `стр. ${i + 1}: вылезла за поле справа/сверху`);
            if (fit === 'fill') {
              assert.ok(Math.abs(p.w - (dims[2] - 2 * margin)) < eps && Math.abs(p.h - (dims[3] - 2 * margin)) < eps, `стр. ${i + 1}: не занимает всё поле`);
            } else {
              // без искажений (допуск на округление до сотых) и упирается в одну из границ поля
              assert.ok(Math.abs(p.w / p.h - iw / ih) < 0.02 * iw / ih + 0.01, `стр. ${i + 1}: пропорции искажены`);
              const touchesW = Math.abs(p.w - (dims[2] - 2 * margin)) < eps;
              const touchesH = Math.abs(p.h - (dims[3] - 2 * margin)) < eps;
              assert.ok(touchesW || touchesH, `стр. ${i + 1}: не вписана максимально`);
              assert.ok(Math.abs(p.x - (dims[2] - p.w) / 2) < eps && Math.abs(p.y - (dims[3] - p.h) / 2) < eps, `стр. ${i + 1}: не по центру`);
            }
          });
        });
      }
    }
  }

  test('размер по умолчанию — A4 без полей, неизвестный размер тоже A4', async () => {
    const { page } = await unitPage(browser, server);
    for (const opts of [{}, { size: 'a5-неизвестный' }]) {
      const pdf = parsePdf(await build(page, [[300, 400], [400, 300]], opts));
      assert.deepEqual(pdf.pages, [A4, A4]);
      assert.deepEqual(pdf.errors, []);
    }
  });

  test('одна страница и много страниц', async () => {
    const { page } = await unitPage(browser, server);
    for (const n of [1, 40]) {
      const sizes = Array.from({ length: n }, (_, i) => [60 + (i % 5) * 10, 80 + (i % 7) * 10]);
      const pdf = parsePdf(await build(page, sizes));
      assert.deepEqual(pdf.errors, []);
      assert.equal(pdf.count, n);
      assert.equal(pdf.pages.length, n);
    }
  });

  test('кириллица и эмодзи в заголовке не ломают файл', async () => {
    const { page } = await unitPage(browser, server);
    const title = 'Заявление №1 — копия «Ёж» 😀';
    const buf = await build(page, [[300, 400]], { title });
    assert.deepEqual(parsePdf(buf).errors, []);
    assert.equal(titleOf(buf), title);
    assert.match(buf.toString('latin1'), /\/Producer <FEFF/);
  });

  test('заголовок по умолчанию — «Скан»', async () => {
    const { page } = await unitPage(browser, server);
    assert.equal(titleOf(await build(page, [[10, 10]])), 'Скан');
  });

  test('цветовое пространство берётся из числа каналов JPEG', async () => {
    const { page } = await unitPage(browser, server);
    const b64 = await inApp(page, async ({ pdf, util }) => {
      const sof = comps => new Blob([new Uint8Array([0xFF, 0xD8, 0xFF, 0xC0, 0, 8 + 3 * comps, 8, 0, 20, 0, 10, comps, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xFF, 0xD9])]);
      return util.b64(await pdf.buildPdf([sof(1), sof(3), sof(4)]));
    });
    const pdf = parsePdf(Buffer.from(b64, 'base64'));
    assert.deepEqual(pdf.errors, []);
    assert.deepEqual(pdf.images.map(i => i.cs), ['DeviceGray', 'DeviceRGB', 'DeviceCMYK']);
  });

  test('пустой список страниц даёт корректный файл', async () => {
    const { page } = await unitPage(browser, server);
    const pdf = parsePdf(await build(page, []));
    assert.deepEqual(pdf.errors, []);
    assert.equal(pdf.count, 0);
  });
});
