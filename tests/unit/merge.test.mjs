// Объединение PDF (pdftools.mergePdfs): работает и в Node, поэтому запускается без браузера.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PdfDoc, PdfError, Ref, assertValidPdf, blobBytes, fx, handPdf, isDict, isName, latin1, manifest, objectCount,
  openDoc, pageContent, pageGeom, pageMarks,
} from '../pdfutil.mjs';
import { Writer, mergePdfs, textStr } from '../../app/pdftools.js';
import { name } from '../../app/pdfread.js';

const merged = async (names, opts) => {
  const r = await mergePdfs(names.map(n => (typeof n === 'string' ? fx(n) : n)), opts);
  const bytes = await blobBytes(r.blob);
  return { ...r, bytes, doc: await PdfDoc.load(bytes) };
};
const T = ['TEXT-P1', 'TEXT-P2', 'TEXT-P3'];

describe('порядок, число и содержимое страниц', () => {
  test('три файла разной упаковки: 9 страниц в порядке файлов, таблица ссылок корректна', async () => {
    const r = await merged(['text', 'objstm', 'linearized']);
    assert.equal(r.pages, 9);
    assert.equal(r.doc.pageRefs.length, 9);
    assert.deepEqual(await pageMarks(r.doc), [...T, ...T, ...T]);
    assertValidPdf(r.bytes, assert);
    assert.equal(r.blob.type, 'application/pdf');
  });

  test('порядок источников меняет порядок страниц', async () => {
    const r = await merged(['hybrid', 'text', 'images']);
    const marks = await pageMarks(r.doc);
    assert.deepEqual(marks.slice(0, 4), ['HYB-P1', ...T]);
    assert.equal(marks.length, 1 + 3 + manifest['images.pdf'].pages);
    assert.equal(marks[4], 'IMG-P1');
  });

  test('один источник даёт копию с теми же страницами', async () => {
    const r = await merged(['text']);
    assert.equal(r.pages, 3);
    assert.deepEqual(await pageMarks(r.doc), T);
  });

  test('размеры страниц сохраняются (A4, Letter, A5 альбомная)', async () => {
    const r = await merged(['text', 'text']);
    const boxes = [];
    for (const p of r.doc.pageRefs) boxes.push((await pageGeom(r.doc, p)).box);
    const one = [[0, 0, 595, 842], [0, 0, 612, 792], [0, 0, 595, 420]];
    assert.deepEqual(boxes, [...one, ...one]);
  });

  test('содержимое страниц побайтно то же, что и в исходных файлах', async () => {
    const r = await merged(['text', 'incremental']);
    const src = [await PdfDoc.load(fx('text')), await PdfDoc.load(fx('incremental'))];
    const want = [];
    for (const d of src) for (const p of d.pageRefs) want.push(await pageContent(d, p));
    const got = [];
    for (const p of r.doc.pageRefs) got.push(await pageContent(r.doc, p));
    assert.deepEqual(got, want);
  });

  test('/Rotate берётся из новой ревизии и не теряется; унаследованные Rotate/MediaBox/Resources переносятся на страницы', async () => {
    const r = await merged(['incremental', 'inherited']);
    const g = [];
    for (const p of r.doc.pageRefs) g.push(await pageGeom(r.doc, p));
    assert.deepEqual(g.map(x => x.rotate), [90, 0, 0, 180, 90, 180]);
    assert.deepEqual(g.slice(3).map(x => x.box), manifest['inherited.pdf'].mediaBoxes);
    for (const p of r.doc.pageRefs.slice(3)) {
      assert.ok(p.dict.has('Resources') && p.dict.has('MediaBox'), 'у страницы есть свои ресурсы и MediaBox');
    }
    assert.deepEqual(await pageMarks(r.doc), [...T, ...T]);
  });

  test('страница без MediaBox получает A4 по умолчанию', async () => {
    const s = latin1(handPdf([{ text: 'NOBOX-P1' }])).replace(/\/MediaBox \[[^\]]*\]/, '');
    const r = await merged([new Uint8Array(Buffer.from(s, 'latin1')), 'text']);
    assert.deepEqual((await pageGeom(r.doc, r.doc.pageRefs[0])).box, [0, 0, 595.28, 841.89]);
  });

  test('файлы из восстановленной таблицы (битый startxref, сдвиг, мусор в начале, обрезанный) объединяются', async () => {
    const r = await merged(['bad-startxref', 'shifted', 'junk-prefix', 'truncated']);
    assert.deepEqual(await pageMarks(r.doc), [...T, ...T, ...T, ...T]);
    assertValidPdf(r.bytes, assert);
  });

  test('картинки: все 11 страниц с картинками копируются, потоки картинок не меняются', async () => {
    const src = await PdfDoc.load(fx('images'));
    const r = await merged(['images']);
    assert.equal(r.pages, 11);
    const imgs = async d => {
      const out = [];
      for (const p of d.pageRefs) {
        const res = await d.get(p.dict.get('Resources') ?? p.inherited.Resources);
        const xo = await d.get(res.get('XObject'));
        const im = await d.get(xo.get('Im0'));
        out.push({ raw: Buffer.from(im.raw).toString('base64'), w: im.dict.get('Width'), filter: String((await d.get(im.dict.get('Filter')))?.n ?? (await d.get(im.dict.get('Filter')))?.map?.(x => x.n)) });
      }
      return out;
    };
    assert.deepEqual(await imgs(r.doc), await imgs(src));
  });

  test('пустой список источников не зависает: получается PDF без страниц или ошибка', async () => {
    try {
      const r = await mergePdfs([]);
      assert.equal(r.pages, 0);
    } catch (e) {
      assert.ok(e instanceof Error);
    }
  });
});

describe('ссылки и лишние объекты', () => {
  test('ссылка-аннотация /Dest ведёт на скопированную страницу, а не на чужие объекты', async () => {
    const r = await merged(['text', 'link']);
    const d = r.doc;
    // link.pdf начинается с шестой страницы объединения
    const linkPage = d.pageRefs[3];
    const annots = await d.get(linkPage.dict.get('Annots'));
    assert.equal(annots.length, 2);
    const dest = await d.get(annots[0]);
    const target = dest.get('Dest')[0];
    assert.ok(target instanceof Ref);
    assert.equal(target.num, d.pageRefs[5].ref.num, '/Dest указывает на третью страницу link.pdf в новом файле');
    const goto = await d.get(annots[1]);
    assert.equal((await d.get(goto.get('A'))).get('D')[0].num, d.pageRefs[4].ref.num, '/A GoTo — на вторую');
    assert.equal(dest.get('P').num, linkPage.ref.num, '/P — на саму страницу');
  });

  test('две копии одного файла со ссылками: каждая ссылается на свою копию', async () => {
    const r = await merged(['link', 'link']);
    const d = r.doc;
    for (const [first, last] of [[0, 2], [3, 5]]) {
      const annots = await d.get(d.pageRefs[first].dict.get('Annots'));
      const dest = await d.get(annots[0]);
      assert.equal(dest.get('Dest')[0].num, d.pageRefs[last].ref.num);
    }
  });

  test('закладки, каталог и «чужие» страницы в результат не попадают', async () => {
    const r = await merged(['text', 'link']);
    const s = latin1(r.bytes);
    assert.doesNotMatch(s, /\/Outlines/, 'закладок нет');
    assert.doesNotMatch(s, /\/PageMode|\/OpenAction/);
    // ровно по одному объекту /Type /Page на страницу и одно дерево страниц
    assert.equal((s.match(/\/Type \/Page\b(?!s)/g) || []).length, 6);
    assert.equal((s.match(/\/Type \/Pages\b/g) || []).length, 1);
    assert.equal((s.match(/\/Type \/Catalog\b/g) || []).length, 1);
  });

  test('общие ресурсы (шрифт) копируются один раз, а не на каждую страницу', async () => {
    const r = await merged(['inherited']);
    const s = latin1(r.bytes);
    assert.equal((s.match(/\/BaseFont \/Helvetica\b/g) || []).length, 1);
  });

  test('число объектов растёт линейно: объединение с самим собой — не больше суммы одиночных', async () => {
    const one = objectCount((await merged(['link'])).bytes);
    const two = objectCount((await merged(['link', 'link'])).bytes);
    assert.ok(two <= 2 * one, `${two} > 2 × ${one}`);
  });

  test('один и тот же PdfDoc можно передать дважды: страницы и ссылки дублируются без путаницы', async () => {
    const doc = await PdfDoc.load(fx('link'));
    const r = await mergePdfs([doc, doc]);
    const out = await openDoc(r.blob);
    assert.equal(out.pageRefs.length, 6);
    assert.deepEqual(await pageMarks(out), [...T, ...T]);
    // каждая копия ссылается на страницы СВОЕЙ копии (copyPages: ключ `doc.id:номер` один на обе копии)
    const a = await out.get(out.pageRefs[0].dict.get('Annots'));
    const dest = (await out.get(a[0])).get('Dest')[0].num;
    assert.equal(dest, out.pageRefs[2].ref.num, 'в первой копии ссылка ведёт на третью страницу первой же копии');
  });

  test('источники можно смешивать: байты и уже открытые PdfDoc', async () => {
    const r = await mergePdfs([fx('text'), await PdfDoc.load(fx('objstm'))]);
    assert.equal(r.pages, 6);
  });
});

describe('название, прогресс, ошибки', () => {
  test('название документа (кириллица, эмодзи) записывается в /Info как UTF-16', async () => {
    const title = 'Договор №5 — копия 😀';
    const r = await merged(['text'], { title });
    const m = /\/Title <([0-9a-f]+)>/i.exec(latin1(r.bytes));
    assert.ok(m, 'в Info есть Title');
    assert.ok(m[1].toUpperCase().startsWith('FEFF'));
    assert.equal(Buffer.from(m[1].slice(4), 'hex').swap16().toString('utf16le'), title);
    assert.equal(r.doc.trailer.get('Info') instanceof Ref, true);
  });

  test('textStr: пары суррогатов и границы', () => {
    assert.deepEqual([...textStr('').bytes], [0xFE, 0xFF]);
    assert.deepEqual([...textStr('A').bytes], [0xFE, 0xFF, 0, 0x41]);
    assert.deepEqual([...textStr('😀').bytes], [0xFE, 0xFF, 0xD8, 0x3D, 0xDE, 0x00]);
  });

  test('onProgress вызывается по разу на страницу: (k, n) от 1 до числа страниц', async () => {
    const calls = [];
    await mergePdfs([fx('text'), fx('hybrid')], { onProgress: (k, n) => calls.push([k, n]) });
    assert.deepEqual(calls, [[1, 4], [2, 4], [3, 4], [4, 4]]);
  });

  test('зашифрованный источник: PdfError «зашифрован», результата нет', async () => {
    await assert.rejects(mergePdfs([fx('text'), fx('encrypted')]), e => e instanceof PdfError && /зашифр/.test(e.message));
  });

  test('не PDF среди источников: PdfError', async () => {
    await assert.rejects(mergePdfs([fx('text'), new Uint8Array([1, 2, 3])]), e => e instanceof PdfError && /не PDF/.test(e.message));
  });

  test('результат можно сразу объединить ещё раз (повторное объединение)', async () => {
    const a = await merged(['text', 'hybrid']);
    const b = await merged([a.bytes, a.bytes, 'objstm']);
    assert.equal(b.pages, 4 + 4 + 3);
    assert.deepEqual((await pageMarks(b.doc)).slice(0, 4), [...T, 'HYB-P1']);
    assertValidPdf(b.bytes, assert);
  });
});

describe('большие и необычные файлы', () => {
  test('300 страниц + 300 страниц: быстро, число страниц и порядок верны', async () => {
    const mk = tag => handPdf(Array.from({ length: 300 }, (_, i) => ({ text: `${tag}-P${i + 1}` })));
    const t0 = Date.now();
    const r = await merged([mk('AAA'), mk('BBB')]);
    assert.equal(r.pages, 600);
    assert.ok(Date.now() - t0 < 15000, `слишком долго: ${Date.now() - t0} мс`);
    const first = await pageContent(r.doc, r.doc.pageRefs[0]);
    const last = await pageContent(r.doc, r.doc.pageRefs[599]);
    assert.match(first, /\(AAA-P1\)/);
    assert.match(last, /\(BBB-P300\)/);
    assertValidPdf(r.bytes, assert);
  });

  test('страница с Contents-массивом из нескольких потоков копируется целиком', async () => {
    const s = latin1(handPdf([{ text: 'ONE', extra: '' }], {
      extraObjs: { 20: { dict: '', data: Buffer.from('BT /F1 20 Tf 50 150 Td (PART-B) Tj ET') } },
    })).replace('/Contents 4 0 R', '/Contents [4 0 R 20 0 R]');
    // таблица смещений устарела — сработает восстановление
    const r = await merged([new Uint8Array(Buffer.from(s, 'latin1')), 'text']);
    const c = await pageContent(r.doc, r.doc.pageRefs[0]);
    assert.match(c, /\(ONE\)/);
    assert.match(c, /\(PART-B\)/);
  });

  test('Writer: объекты нумеруются подряд, xref корректна и для пустых объектов', () => {
    const w = new Writer();
    const a = w.alloc(); const b = w.alloc();
    w.set(a, new Map([['Type', name('Catalog')]]));
    // b остаётся неустановленным → записывается как null
    const blob = w.toBlob(new Ref(a, 0), null);
    return blobBytes(blob).then(bytes => {
      assertValidPdf(bytes, assert);
      assert.equal(b, 2);
    });
  });
});
