// Регрессии по итогам код-ревью, которые честно проверяются только в браузере:
// Chromium строже Node к хвосту Flate-потока; перекодирование картинок использует canvas.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { after, before, describe, test } from 'node:test';
import { launch, startServer, unitPage } from '../helpers.mjs';
import { compressInBrowser } from '../browser-pdf.mjs';
import { PdfDoc, fx, imageInfo, imagePdf, objStmPdf, tightImagePdf } from '../pdfutil.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

/** Распаковка Flate-данных в браузере модулем pdfread.js: base64 → { ok, text } или { error }. */
const unflate = async (page, data) => page.evaluate(async b64 => {
  const m = await import('./pdfread.js');
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  try {
    const r = await m.decodeStream(new m.Stream(new Map([['Filter', m.name('FlateDecode')]]), raw), new Set(), v => v);
    return { length: r.data.length, head: new TextDecoder('latin1').decode(r.data.subarray(0, 12)) };
  } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; }
}, Buffer.from(data).toString('base64'));

describe('1. Flate с дефектами в браузере', () => {
  const payload = Buffer.from('ABCDEFGHIJ'.repeat(500));
  const z = zlib.deflateSync(payload);

  test('CRLF после данных, неверная adler32, без заголовка zlib распаковываются полностью', async () => {
    const { page } = await unitPage(browser, server);
    const cases = {
      'CRLF': Buffer.concat([z, Buffer.from('\r\n')]),
      'пробелы': Buffer.concat([z, Buffer.from(' \n \r\n')]),
      'adler32': Buffer.concat([z.subarray(0, -4), Buffer.alloc(4)]),
      'без заголовка': zlib.deflateRawSync(payload),
      'adler32 и CRLF': Buffer.concat([z.subarray(0, -4), Buffer.alloc(4), Buffer.from('\r\n')]),
    };
    for (const [what, data] of Object.entries(cases)) {
      const r = await unflate(page, data);
      assert.equal(r.length, payload.length, `${what}: ${JSON.stringify(r)}`);
      assert.equal(r.head, 'ABCDEFGHIJAB');
    }
  });

  test('обрезанный поток даёт распакованную часть, мусор — PdfError', async () => {
    const { page } = await unitPage(browser, server);
    const noise = Buffer.alloc(30000);
    let s = 7;
    for (let i = 0; i < noise.length; i++) { s = (s * 1103515245 + 12345) >>> 0; noise[i] = s >>> 24; }
    const full = zlib.deflateSync(noise);
    const r = await unflate(page, full.subarray(0, Math.floor(full.length * 0.6)));
    assert.ok(r.length > 1000 && r.length < noise.length, JSON.stringify(r));
    assert.match((await unflate(page, new Uint8Array(20).fill(0xFF))).error, /PdfError/);
  });

  for (const variant of ['ok', 'crlf', 'adler', 'raw']) {
    test(`поток объектов (${variant}): PDF открывается по таблице, страница и содержимое на месте`, async () => {
      const { page } = await unitPage(browser, server);
      const r = await page.evaluate(async b64 => {
        const m = await import('./pdfread.js');
        let rebuilt = 0;
        const orig = m.PdfDoc.prototype.rebuildXref;
        m.PdfDoc.prototype.rebuildXref = function (...a) { rebuilt++; return orig.apply(this, a); };
        try {
          const doc = await m.PdfDoc.load(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
          const c = await doc.get(doc.pageRefs[0].dict.get('Contents'));
          return { pages: doc.pageRefs.length, content: new TextDecoder('latin1').decode(await doc.decode(c)), rebuilt };
        } catch (e) { return { error: `${e.constructor.name}: ${e.message}` }; } finally { m.PdfDoc.prototype.rebuildXref = orig; }
      }, Buffer.from(objStmPdf(variant)).toString('base64'));
      assert.equal(r.error, undefined);
      assert.equal(r.pages, 1);
      assert.match(r.content, /\(OBJ-P1\)/);
      assert.equal(r.rebuilt, 0);
    });
  }

  test('сжатие PDF, у которого дерево страниц в повреждённом потоке объектов (CRLF), не теряет страницу', async () => {
    const { page } = await unitPage(browser, server);
    const r = await compressInBrowser(page, objStmPdf('crlf'), 1e9);
    assert.equal(r.pages, 1);
    assert.equal((await PdfDoc.load(r.bytes)).pageRefs.length, 1);
  });
});

describe('6–7. сжатие картинок', () => {
  test('6. SMask с /Matte: картинка не перекодируется и не уменьшается (размеры маски и картинки согласованы)', async () => {
    const { page } = await unitPage(browser, server);
    const src = (await imageInfo(await PdfDoc.load(fx('matte'))))[0];
    assert.ok(src.smask, 'в фикстуре есть маска');
    const r = await compressInBrowser(page, fx('matte'), 1000);
    const out = (await imageInfo(await PdfDoc.load(r.bytes)))[0];
    assert.equal(out.hash, src.hash, 'данные картинки не изменились');
    assert.deepEqual([out.w, out.h, out.filter], [src.w, src.h, src.filter]);
    assert.deepEqual(out.smask, src.smask);
    assert.equal(r.images, 0, 'такая картинка не считается сжимаемой');
  });

  test('7. даже сильнейший уровень не меньше «без потерь»: level -1 и вариант без потерь', async () => {
    const { page } = await unitPage(browser, server);
    const lossless = await compressInBrowser(page, fx('compressed'), 1e9);
    assert.equal(lossless.level, -1);
    const r = await compressInBrowser(page, fx('compressed'), 1000);
    assert.equal(r.fits, false);
    assert.equal(r.level, -1, 'без изменений картинок уровень не 13');
    assert.equal(r.size, lossless.size, 'это тот же вариант без потерь');
    assert.deepEqual(Buffer.from(r.bytes), Buffer.from(lossless.bytes));
    assert.equal(r.images, 1, 'картинка сжимаемая, но уже сжата сильнее');
    const out = (await imageInfo(await PdfDoc.load(r.bytes)))[0];
    const src = (await imageInfo(await PdfDoc.load(fx('compressed'))))[0];
    assert.equal(out.hash, src.hash);
  });

  test('images считает только сжимаемые картинки', async () => {
    const { page } = await unitPage(browser, server);
    const imgs = await compressInBrowser(page, fx('images'), 1000);
    // 1 A85+DCT, 2 Flate, 3 Gray, 4 SMask-картинка, 6 Gray DCT, 7 ICC (CMYK, мелкая, ImageMask, Indexed и цветовая маска — нет)
    assert.equal(imgs.images, 6);
    assert.equal((await compressInBrowser(page, fx('text'), 1000)).images, 0);
  });
});

describe('3. частичная распаковка: быстро и с испорченным заголовком', () => {
  const noise = n => crypto.randomBytes(n); // несжимаемые данные: размер упакованного ≈ размеру исходного

  test('обрезанный поток 3–4 МБ распаковывается частично быстро (меньше 1,5 с), без пауз на каждый кусок', async () => {
    const { page } = await unitPage(browser, server);
    const full = zlib.deflateSync(noise(4_000_000), { level: 1 });
    const part = full.subarray(0, Math.floor(full.length * 0.7));
    assert.ok(part.length > 2_500_000);
    const t0 = Date.now();
    const r = await unflate(page, part);
    const ms = Date.now() - t0;
    assert.ok(r.length > 1_000_000, JSON.stringify(r));
    assert.ok(ms < 1500, `${ms} мс`);
  });

  test('два испорченных байта заголовка zlib и мусор в конце: распаковывается начало данных', async () => {
    const { page } = await unitPage(browser, server);
    const payload = noise(60000);
    const z = zlib.deflateSync(payload);
    const bad = Buffer.concat([Buffer.from([0x00, 0x00]), z.subarray(2, -4), Buffer.from('мусор после данных, не adler')]);
    const r = await unflate(page, bad);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.ok(r.length >= payload.length * 0.9, `${r.length} из ${payload.length}`);
  });
});

describe('6. файл с картинками не уменьшился', () => {
  test('условия: картинки сжимаемые, «без потерь» не меньше исходного, сильнейший уровень тоже', async () => {
    const { page } = await unitPage(browser, server);
    const raw = (await imageInfo(await PdfDoc.load(fx('compressed'))))[0].raw;
    const pdf = await tightImagePdf(raw, 500, 500, 3);
    const r = await compressInBrowser(page, pdf, 1000);
    assert.equal(r.images, 3);
    assert.equal(r.level, -1);
    assert.ok(r.size >= r.original, `без потерь ${r.size} < исходного ${r.original}: сценарий не тот`);
  });
});
