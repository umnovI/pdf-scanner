// Сжатие PDF (pdftools.compressPdf): работает только в браузере (canvas, createImageBitmap).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { launch, startServer, unitPage, parsePdf } from '../helpers.mjs';
import { compressInBrowser, noisyJpegs } from '../browser-pdf.mjs';
import {
  PdfDoc, PdfError, assertValidPdf, fx, imagePdf, imageInfo, latin1, manifest, pageContent, pageGeom, pageMarks,
} from '../pdfutil.mjs';
import { LEVELS } from '../../app/pdftools.js';
import { jpegInfo } from '../../app/pdf.js';

let server, browser, big, bigPdf;
const LAST = LEVELS.length - 1;

before(async () => {
  server = await startServer();
  browser = await launch();
  // Исходные данные: PDF как у reportlab — 3 страницы, на каждой шумная картинка 1200×1600 в ASCII85+DCT (около 6 МБ).
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(server.url + '__blank.html');
  big = await noisyJpegs(page, [{ w: 1200, h: 1600 }, { w: 1200, h: 1600 }, { w: 1200, h: 1600 }]);
  await ctx.close();
  bigPdf = imagePdf(big.map(j => ({ bytes: Buffer.from(j.b64, 'base64'), w: j.w, h: j.h })));
});
after(async () => { await browser?.close(); await server?.close(); });

const run = async (bytes, target) => {
  const { page } = await unitPage(browser, server);
  return compressInBrowser(page, bytes, target);
};

/** Общие проверки результата: открывается, страницы и текст на месте, структура корректна. */
async function assertSound(r, { pages, marks }) {
  assertValidPdf(r.bytes, assert);
  const doc = await PdfDoc.load(r.bytes);
  assert.equal(doc.pageRefs.length, pages);
  assert.equal(r.pages, pages);
  if (marks) assert.deepEqual(await pageMarks(doc), marks);
  assert.equal(r.size, r.bytes.length, 'size совпадает с размером blob');
  return doc;
}

describe('цель размера', () => {
  test('цель выше размера без потерь: только пересборка (level -1), картинки не тронуты, ASCII85 снят', async () => {
    const r = await run(bigPdf, 5.9e6); // исходник ~6,3 МБ; без ASCII85 около 5 МБ
    assert.equal(r.fits, true);
    assert.equal(r.level, -1);
    assert.ok(r.size <= 5.9e6 && r.size < r.original, `${r.size} из ${r.original}`);
    const doc = await assertSound(r, { pages: 3, marks: ['BIG-P1', 'BIG-P2', 'BIG-P3'] });
    const imgs = await imageInfo(doc);
    for (const [i, im] of imgs.entries()) {
      assert.equal(im.filter, 'DCTDecode', 'ASCII85 снят, остался чистый JPEG');
      assert.deepEqual(Buffer.from(im.raw), Buffer.from(big[i].b64, 'base64'), 'JPEG побайтно тот же');
    }
    assert.equal(r.stages.some(s => s.stage === 'images'), false, 'картинки не перекодировались');
  });

  test('цель ниже размера без потерь: картинки перекодируются, итог не больше цели', async () => {
    const r = await run(bigPdf, 3e6);
    assert.equal(r.fits, true);
    assert.ok(r.level >= 0, `уровень ${r.level}`);
    assert.ok(r.size <= 3e6, `${r.size} > 3000000`);
    const doc = await assertSound(r, { pages: 3, marks: ['BIG-P1', 'BIG-P2', 'BIG-P3'] });
    for (const im of await imageInfo(doc)) {
      assert.equal(im.filter, 'DCTDecode');
      assert.ok(Math.max(im.w, im.h) <= LEVELS[r.level].maxSide);
    }
  });

  test('развёртка целей от 4 МБ до 0,12 МБ: уложились, уровни растут, лучшее качество из подходящих', async () => {
    const { page } = await unitPage(browser, server);
    const go = t => compressInBrowser(page, bigPdf, t);
    const res = [];
    for (const t of [4e6, 1e6, 3e5, 1.2e5]) res.push({ t, ...(await go(t)) });
    for (const r of res) {
      assert.equal(r.fits, true, `цель ${r.t}: не уложились (размер ${r.size}, уровень ${r.level})`);
      assert.ok(r.size <= r.t, `цель ${r.t}: размер ${r.size}`);
    }
    for (let i = 1; i < res.length; i++) assert.ok(res[i].level >= res[i - 1].level, 'чем меньше цель, тем сильнее сжатие');
    // качество наилучшее: результат более слабого уровня не уместился бы в цель с более сильным
    for (const a of res) for (const b of res) {
      if (a.level >= 0 && a.level < b.level) assert.ok(a.size > b.t, `уровень ${a.level} (${a.size} Б) уместился бы в цель ${b.t}, но выбран уровень ${b.level}`);
    }
    // цель впритык: размер результата в качестве цели даёт тот же уровень, а на байт меньше — уже другой
    const mid = res.find(r => r.level > 0);
    assert.ok(mid, 'в развёртке есть сжатие картинок');
    const again = await go(mid.size);
    assert.equal(again.level, mid.level);
    assert.equal(again.fits, true);
    const tighter = await go(mid.size - 1);
    assert.ok(!tighter.fits || tighter.level > mid.level, 'на байт меньше цель — уже другой уровень');
  });

  test('недостижимая цель: fits=false, самый сильный уровень, возвращается самый маленький вариант', async () => {
    const a = await run(bigPdf, 1000);
    const b = await run(bigPdf, 50000);
    assert.equal(a.fits, false);
    assert.equal(a.level, LAST);
    assert.ok(a.size < a.original, 'всё равно меньше исходного');
    assert.equal(a.size, b.size, 'любая недостижимая цель даёт один и тот же самый маленький файл');
    await assertSound(a, { pages: 3, marks: ['BIG-P1', 'BIG-P2', 'BIG-P3'] });
    assert.ok(a.size > 1000);
  });

  test('цель ровно равна размеру самого сильного сжатия: уложились на последнем уровне', async () => {
    const smallest = await run(bigPdf, 1);
    const r = await run(bigPdf, smallest.size);
    assert.equal(r.fits, true);
    assert.equal(r.level, LAST);
    assert.equal(r.size, smallest.size);
  });

  test('цель 0 и отрицательная: не падает, fits=false', async () => {
    for (const t of [0, -5]) {
      const r = await run(fx('text'), t);
      assert.equal(r.fits, false, `цель ${t}`);
    }
  });
});

describe('что именно сжимается', () => {
  test('картинки: JPEG/Flate RGB/Gray/ICC перекодируются; маска, CMYK, мелочь, ImageMask, Indexed — нет', async () => {
    const src = await imageInfo(await PdfDoc.load(fx('images')));
    const r = await run(fx('images'), 1000);
    assert.equal(r.fits, false);
    const doc = await assertSound(r, { pages: 11, marks: manifest['images.pdf'].marks });
    const out = await imageInfo(doc);
    const changed = i => out[i].hash !== src[i].hash;
    // 1 ASCII85+DCT, 2 Flate RGB, 3 Gray+предиктор, 6 Gray DCT, 7 ICC
    for (const i of [0, 1, 2, 5, 6]) {
      assert.ok(changed(i), `страница ${i + 1} должна быть перекодирована`);
      assert.equal(out[i].filter, 'DCTDecode');
      assert.ok(out[i].size < src[i].size, `страница ${i + 1}: ${out[i].size} ≥ ${src[i].size}`);
      assert.equal(out[i].bpc, 8);
    }
    assert.equal(out[2].cs, 'DeviceRGB', 'серая Flate-картинка стала цветным JPEG и получила DeviceRGB');
    assert.equal(out[5].cs, 'DeviceRGB', 'серый JPEG стал цветным JPEG и получил DeviceRGB');
    assert.equal(out[6].cs, 'ICCBased', 'ICC-профиль сохранён');
    // не трогаются
    assert.equal(changed(4), false, 'CMYK-JPEG не тронут');
    assert.equal(out[4].hasDecode, true, 'массив /Decode CMYK сохранён');
    assert.equal(changed(7), false, 'картинка меньше 16 КБ не тронута');
    assert.equal(changed(8), false, 'ImageMask не тронута');
    assert.equal(out[8].imageMask, true);
    assert.equal(changed(9), false, 'Indexed не тронута');
    assert.equal(out[9].cs, 'Indexed');
  });

  test('картинка с SMask: сама перекодируется, а маска остаётся прежней Flate-картинкой и привязана', async () => {
    const src = (await imageInfo(await PdfDoc.load(fx('images'))))[3];
    const r = await run(fx('images'), 1000);
    const out = (await imageInfo(await PdfDoc.load(r.bytes)))[3];
    assert.ok(out.smask, 'ссылка /SMask не потеряна');
    assert.deepEqual(out.smask, src.smask, 'маска побайтно та же: Flate, 160×160');
    assert.equal(out.smask.filter, 'FlateDecode');
    assert.equal(out.filter, 'DCTDecode');
  });

  test('картинка с цветовой маской /Mask [..] не должна превращаться в JPEG (ключ цвета перестанет совпадать)', async () => {
    const r = await run(fx('images'), 1000);
    const out = (await imageInfo(await PdfDoc.load(r.bytes)))[10];
    assert.ok(out.hasMask, 'маска на месте');
    assert.notEqual(out.filter, 'DCTDecode', 'с цветовым ключом JPEG даёт «дырявую» прозрачность');
  });

  test('ни одна картинка не становится больше исходной (в любом уровне)', async () => {
    const src = await imageInfo(await PdfDoc.load(fx('images')));
    for (const t of [400000, 200000, 1000]) {
      const out = await imageInfo(await PdfDoc.load((await run(fx('images'), t)).bytes));
      out.forEach((o, i) => assert.ok(o.size <= src[i].size, `цель ${t}, страница ${i + 1}: ${o.size} > ${src[i].size}`));
    }
  });

  test('уже сильно сжатый JPEG (качество 3) не раздувается: картинка остаётся как была либо становится меньше', async () => {
    const src = (await imageInfo(await PdfDoc.load(fx('lowq'))))[0];
    assert.ok(src.size >= 16 * 1024, `фикстура слишком мала: ${src.size}`);
    for (const t of [Math.floor(fx('lowq').length * 0.99), 30000, 1000]) {
      const r = await run(fx('lowq'), t);
      const out = (await imageInfo(await PdfDoc.load(r.bytes)))[0];
      assert.ok(out.size <= src.size, `цель ${t}: ${out.size} > ${src.size}`);
      if (out.hash === src.hash) assert.equal(out.filter, 'DCTDecode');
      assert.ok(r.size <= fx('lowq').length + 2048, 'итог не больше исходного (с запасом на служебные данные)');
    }
  });

  test('большая картинка уменьшается не больше уровня, пропорции сохраняются; маленькая не увеличивается', async () => {
    const { page } = await unitPage(browser, server);
    const imgs = await noisyJpegs(page, [
      { w: 3000, h: 4000, q: 0.9, noise: 60, smooth: true },
      { w: 800, h: 600, q: 0.95, noise: 120, smooth: true },
    ]);
    const pdf = imagePdf(imgs.map(j => ({ bytes: Buffer.from(j.b64, 'base64'), w: j.w, h: j.h })), { a85: false });
    const r = await compressInBrowser(page, pdf, 5e5);
    assert.equal(r.fits, true);
    const [a, b] = await imageInfo(await PdfDoc.load(r.bytes));
    const max = LEVELS[r.level].maxSide;
    assert.ok(Math.max(a.w, a.h) <= max && Math.max(a.w, a.h) >= max - 1, `большая: ${a.w}×${a.h}, потолок ${max}`);
    assert.ok(Math.abs(a.w / a.h - 0.75) < 0.01, `пропорции ${a.w}×${a.h}`);
    assert.ok(b.w <= 800 && b.h <= 600, `маленькая выросла: ${b.w}×${b.h}`);
    // размеры в словаре картинки совпадают с настоящими размерами JPEG
    for (const o of [a, b]) {
      const info = jpegInfo(o.raw);
      assert.deepEqual([info.width, info.height], [o.w, o.h]);
    }
  });

  test('ориентация EXIF не применяется (PDF её не знает): размеры картинки после сжатия те же, книжные', async () => {
    const src = (await imageInfo(await PdfDoc.load(fx('exif'))))[0];
    assert.deepEqual([src.w, src.h], [400, 600]);
    const r = await run(fx('exif'), 1000);
    const o = (await imageInfo(await PdfDoc.load(r.bytes)))[0];
    assert.ok(o.h > o.w, `картинка повернулась на 90°: ${o.w}×${o.h}, а страница рисует её как ${src.w}×${src.h}`);
    assert.ok(Math.abs(o.w / o.h - 400 / 600) < 0.01);
  });
});

describe('PDF без картинок и разные упаковки', () => {
  test('текстовый PDF без картинок и недостижимая цель: fits=false, level -1, текст на месте', async () => {
    const r = await run(fx('text'), 100);
    assert.equal(r.fits, false);
    assert.equal(r.level, -1);
    await assertSound(r, { pages: 3, marks: ['TEXT-P1', 'TEXT-P2', 'TEXT-P3'] });
    assert.equal(r.stages.some(s => s.stage === 'images'), false);
  });

  for (const f of ['text', 'objstm', 'linearized', 'incremental', 'inherited', 'link', 'shifted', 'bad-startxref', 'junk-prefix', 'truncated', 'hybrid']) {
    test(`${f}.pdf с большой целью: страницы, метки, размеры и /Rotate сохраняются`, async () => {
      const m = manifest[f + '.pdf'];
      const src = await PdfDoc.load(fx(f));
      const r = await run(fx(f), 1e9);
      assert.equal(r.fits, true);
      assert.equal(r.level, -1);
      const doc = await assertSound(r, { pages: m.pages, marks: m.marks });
      for (let i = 0; i < m.pages; i++) {
        assert.deepEqual(await pageGeom(doc, doc.pageRefs[i]), await pageGeom(src, src.pageRefs[i]), `страница ${i + 1}`);
        assert.equal(await pageContent(doc, doc.pageRefs[i]), await pageContent(src, src.pageRefs[i]));
      }
    });
  }

  test('ссылки между страницами сохраняются и после сжатия ведут на новые страницы', async () => {
    const r = await run(fx('link'), 1e9);
    const d = await PdfDoc.load(r.bytes);
    const annots = await d.get(d.pageRefs[0].dict.get('Annots'));
    const dest = await d.get(annots[0]);
    assert.equal(dest.get('Dest')[0].num, d.pageRefs[2].ref.num);
  });

  test('ошибки: зашифрованный и не PDF отклоняются понятным PdfError', async () => {
    const { page } = await unitPage(browser, server);
    for (const [bytes, re] of [[fx('encrypted'), /зашифр/], [new Uint8Array([1, 2, 3]), /не PDF/]]) {
      const msg = await page.evaluate(async ([b64]) => {
        const { compressPdf, PdfError } = await import('./pdftools.js');
        try { await compressPdf(Uint8Array.from(atob(b64), c => c.charCodeAt(0)), 1000); return 'нет ошибки'; } catch (e) { return `${e instanceof PdfError ? 'PdfError' : e.constructor.name}: ${e.message}`; }
      }, [Buffer.from(bytes).toString('base64')]);
      assert.match(msg, /^PdfError: /);
      assert.match(msg, re);
    }
  });

  test('прогресс: сначала «read», затем «images» с номерами картинок от 1 до N', async () => {
    const r = await run(fx('images'), 1000);
    assert.equal(r.stages[0].stage, 'read');
    const imgs = r.stages.filter(s => s.stage === 'images');
    assert.ok(imgs.length > 0);
    assert.ok(imgs.every(s => s.image >= 1 && s.image <= s.images && s.level >= 0 && s.level <= LAST));
    assert.equal(imgs[0].image, 1);
    assert.equal(imgs.at(-1).image, imgs[0].images);
  });

  test('50 текстовых страниц сжимаются без потерь быстро', async () => {
    const { handPdf } = await import('../pdfutil.mjs');
    const pdf = handPdf(Array.from({ length: 50 }, (_, i) => ({ text: `LONG-P${i + 1}` })));
    const r = await run(pdf, 1e9);
    assert.equal(r.pages, 50);
    assert.ok(r.ms < 5000, `${r.ms} мс`);
  });
});
