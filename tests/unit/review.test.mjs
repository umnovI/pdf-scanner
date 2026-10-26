// Регрессии по итогам код-ревью: распаковка, проверка таблицы xref, восстановление, именованные
// ссылки, слои, кэш записи, строки UTF-16. Работает в Node (модули приложения не требуют DOM).
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { describe, test } from 'node:test';
import {
  PdfDoc, Ref, Stream, blobBytes, decodeStream, fx, handPdf, isDict, latin1, objStmPdf, offsetOf, openDoc, pageGeom,
  pageMarks, patchXref,
} from '../pdfutil.mjs';
import { Writer, compressPdf, mergePdfs, textStr } from '../../app/pdftools.js';
import * as pdfjs from '../../app/pdf.js';
import { Str, name } from '../../app/pdfread.js';

const flate = data => new Stream(new Map([['Filter', name('FlateDecode')]]), data);
const unz = async data => Buffer.from((await decodeStream(flate(data), new Set(), v => v)).data);
const noRebuild = async fn => {
  const orig = PdfDoc.prototype.rebuildXref;
  let n = 0;
  PdfDoc.prototype.rebuildXref = function (...a) { n++; return orig.apply(this, a); };
  try { return { value: await fn(), rebuilt: n }; } finally { PdfDoc.prototype.rebuildXref = orig; }
};

describe('1. распаковка Flate с дефектами', () => {
  const payload = Buffer.from('Привет, PDF! '.repeat(200));
  const z = zlib.deflateSync(payload);

  test('лишние байты после данных (CRLF в /Length), неверная adler32, без заголовка zlib', async () => {
    assert.deepEqual(await unz(Buffer.concat([z, Buffer.from('\r\n')])), payload, 'CRLF');
    assert.deepEqual(await unz(Buffer.concat([z, Buffer.from('\n\n  ')])), payload, 'несколько пробельных');
    assert.deepEqual(await unz(Buffer.concat([z.subarray(0, -4), Buffer.alloc(4)])), payload, 'adler32');
    assert.deepEqual(await unz(zlib.deflateRawSync(payload)), payload, 'без заголовка');
    assert.deepEqual(await unz(Buffer.concat([z.subarray(0, -4), Buffer.alloc(4), Buffer.from('\r\n')])), payload, 'adler32 и CRLF');
  });

  test('обрезанный поток: берётся распакованная часть, а не ошибка', async () => {
    const noise = Buffer.alloc(30000);
    let s = 7;
    for (let i = 0; i < noise.length; i++) { s = (s * 1103515245 + 12345) >>> 0; noise[i] = s >>> 24; }
    const full = zlib.deflateSync(noise);
    const part = await unz(full.subarray(0, Math.floor(full.length * 0.6)));
    assert.ok(part.length > 1000 && part.length < noise.length, `распаковано ${part.length}`);
    assert.deepEqual(part, noise.subarray(0, part.length), 'это начало исходных данных');
  });

  test('совсем негодные данные — по-прежнему PdfError', async () => {
    await assert.rejects(unz(new Uint8Array(20).fill(0xFF)), e => e.constructor.name === 'PdfError');
  });

  for (const variant of ['ok', 'crlf', 'adler', 'raw']) {
    test(`поток объектов (${variant}): страница и дерево страниц из него не пропадают, чтение по таблице`, async () => {
      const { value: doc, rebuilt } = await noRebuild(() => PdfDoc.load(objStmPdf(variant)));
      assert.deepEqual(await pageMarks(doc), ['OBJ-P1']);
      assert.deepEqual((await pageGeom(doc, doc.pageRefs[0])).box, [0, 0, 300, 200]);
      assert.equal(rebuilt, 0);
    });
  }
});

describe('2. проверка таблицы ссылок и числа страниц', () => {
  const three = () => handPdf([{ text: 'A-P1' }, { text: 'B-P2' }, { text: 'C-P3' }]);

  test('исходная сборка читается по порядку (контроль)', async () => {
    assert.deepEqual(await pageMarks(await PdfDoc.load(three())), ['A-P1', 'B-P2', 'C-P3']);
  });

  test('смещения двух страниц перепутаны: порядок и содержимое верные (номер объекта сверяется)', async () => {
    const src = three();
    const o3 = offsetOf(src, 3), o5 = offsetOf(src, 5);
    const bad = patchXref(src, (n, off) => (n === 3 ? o5 : n === 5 ? o3 : off));
    const doc = await PdfDoc.load(bad);
    assert.deepEqual(await pageMarks(doc), ['A-P1', 'B-P2', 'C-P3']);
  });

  test('все смещения страниц указывают не туда, каталог на месте: все страницы найдены', async () => {
    const src = three();
    const o4 = offsetOf(src, 4);
    const bad = patchXref(src, (n, off) => (n === 3 || n === 5 || n === 7 ? o4 : off));
    const doc = await PdfDoc.load(bad);
    assert.deepEqual(await pageMarks(doc), ['A-P1', 'B-P2', 'C-P3']);
  });

  test('потеряна одна страница из трёх: восстановление возвращает все три', async () => {
    const src = three();
    const bad = patchXref(src, (n, off) => (n === 5 ? offsetOf(src, 4) : off));
    const doc = await PdfDoc.load(bad);
    assert.equal(doc.pageRefs.length, 3);
    assert.deepEqual(await pageMarks(doc), ['A-P1', 'B-P2', 'C-P3']);
  });

  for (const count of [1, 7]) {
    test(`неверный /Count ${count} при целой таблице: страницы не теряются`, async () => {
      const s = latin1(three()).replace('/Count 3', `/Count ${count}`);
      const doc = await PdfDoc.load(new Uint8Array(Buffer.from(s, 'latin1')));
      assert.deepEqual(await pageMarks(doc), ['A-P1', 'B-P2', 'C-P3']);
    });
  }

  test('несовпадающая таблица в файле, где страниц в самом деле меньше /Count, не ломает чтение', async () => {
    const s = latin1(handPdf([{ text: 'A-P1' }, { text: 'B-P2' }])).replace('/Count 2', '/Count 5');
    const doc = await PdfDoc.load(new Uint8Array(Buffer.from(s, 'latin1')));
    assert.equal(doc.pageRefs.length, 2);
  });
});

describe('3. восстановление при битом startxref и инкрементальных обновлениях', () => {
  // База: одна страница (/Rotate 0 в прямом объекте 3). Обновление: объект 3 с /Rotate 90 лежит в потоке
  // объектов 10, новый каталог 12, таблица — поток xref 11. startxref испорчен.
  const build = () => {
    const base = Buffer.from(handPdf([{ text: 'UPD-P1', extra: '/Rotate 0' }]));
    const page = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Rotate 90 /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>';
    const head = '3 0 ';
    const objstm = Buffer.from(`10 0 obj\n<< /Type /ObjStm /N 1 /First ${head.length} /Length ${head.length + page.length} >>\nstream\n${head}${page}\nendstream\nendobj\n`);
    const cat = Buffer.from('12 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    let out = Buffer.concat([base, Buffer.from('\n'), objstm, cat]);
    const o10 = out.indexOf('10 0 obj'), o12 = out.indexOf('12 0 obj');
    const rows = Buffer.from([2, 0, 10, 0, /* 3 */ 1, o10 >> 8, o10 & 255, 0, 1, o12 >> 8, o12 & 255, 0]);
    const o11 = out.length;
    const xs = Buffer.concat([
      Buffer.from(`11 0 obj\n<< /Type /XRef /Size 13 /W [1 2 1] /Index [3 1 10 1 12 1] /Root 12 0 R /Length ${rows.length} >>\nstream\n`),
      rows, Buffer.from('\nendstream\nendobj\n'),
    ]);
    out = Buffer.concat([out, xs, Buffer.from('startxref\n99999999\n%%EOF\n')]);
    return { bytes: new Uint8Array(out), o11 };
  };

  test('объект в более позднем потоке объектов побеждает прямой объект старой ревизии', async () => {
    const doc = await PdfDoc.load(build().bytes);
    assert.equal((await pageGeom(doc, doc.pageRefs[0])).rotate, 90, 'взят /Rotate 90 из обновления');
    assert.deepEqual(await pageMarks(doc), ['UPD-P1']);
  });

  test('trailer берётся из последнего потока xref (Root — новый каталог 12)', async () => {
    const doc = await PdfDoc.load(build().bytes);
    assert.equal(doc.trailer.get('Root').num, 12);
  });
});

describe('4. именованные ссылки', () => {
  const destPdf = tag => handPdf([
    { text: `${tag}-P1`, extra: '/Annots [30 0 R 31 0 R 32 0 R]' }, { text: `${tag}-P2` }, { text: `${tag}-P3` },
  ], {
    catalogExtra: '/Names << /Dests 20 0 R >> /Dests << /old [5 0 R /Fit] >>',
    extraObjs: {
      20: '<< /Kids [21 0 R 22 0 R] >>',
      21: '<< /Limits [(a) (chap2)] /Names [(chap2) [5 0 R /XYZ 0 0 null]] >>',
      22: '<< /Limits [(chap3) (z)] /Names [(chap3) << /D [7 0 R /Fit] >>] >>',
      30: '<< /Type /Annot /Subtype /Link /Rect [0 0 10 10] /Dest (chap2) >>',
      31: '<< /Type /Annot /Subtype /Link /Rect [0 20 10 30] /A << /S /GoTo /D (chap3) >> >>',
      32: '<< /Type /Annot /Subtype /Link /Rect [0 40 10 50] /Dest /old >>',
    },
  });

  /** Куда ведут три ссылки первой страницы файла, начинающегося на странице first: номера страниц (с 0) или null. */
  async function targets(doc, first) {
    const nums = doc.pageRefs.map(p => p.ref.num);
    const annots = await doc.get(doc.pageRefs[first].dict.get('Annots'));
    const out = [];
    for (const a of annots) {
      const d = await doc.get(a);
      let dest = d.get('Dest');
      if (!dest) dest = (await doc.get(d.get('A'))).get('D');
      out.push(Array.isArray(dest) ? nums.indexOf(dest[0].num) : null);
    }
    return out;
  }

  test('объединение двух файлов с одинаковыми именами: ссылки становятся явными и ведут каждая в свой файл', async () => {
    const r = await mergePdfs([destPdf('A'), destPdf('B')]);
    const bytes = await blobBytes(r.blob);
    const doc = await openDoc(bytes);
    assert.deepEqual(await targets(doc, 0), [1, 2, 1], 'файл A: chap2→стр.2, chap3→стр.3, old→стр.2');
    assert.deepEqual(await targets(doc, 3), [4, 5, 4], 'файл B: свои страницы');
    const s = latin1(bytes);
    assert.doesNotMatch(s, /\/Names|\/Dests|\(chap2\)|<6368617032>/, 'дерева имён в результате нет');
  });

  test('сжатие: именованные ссылки тоже превращаются в явные', async () => {
    const r = await compressPdf(destPdf('A'), 1e9);
    const doc = await openDoc(r.blob);
    assert.deepEqual(await targets(doc, 0), [1, 2, 1]);
  });

  test('неизвестное имя остаётся как есть и не ломает объединение', async () => {
    const s = latin1(destPdf('A')).replace('/Dest (chap2)', '/Dest (nope6)');
    const r = await mergePdfs([new Uint8Array(Buffer.from(s, 'latin1')), destPdf('B')]);
    assert.equal(r.pages, 6);
  });
});

describe('5. слои (/OCProperties)', () => {
  const ocPdf = tag => handPdf([{ text: `${tag}-P1`, resExtra: ' /Properties << /L1 40 0 R /L2 41 0 R >>' }], {
    catalogExtra: '/OCProperties << /OCGs [40 0 R 41 0 R] /D << /Order [40 0 R 41 0 R] /ON [40 0 R] /OFF [41 0 R] /BaseState /ON >> >>',
    extraObjs: { 40: `<< /Type /OCG /Name (${tag}-visible) >>`, 41: `<< /Type /OCG /Name (${tag}-hidden) >>` },
  });
  const layerNames = async (doc, list) => Promise.all((list || []).map(async r => latin1((await doc.get(await doc.get(r))).get('Name').bytes)));
  const props = async doc => {
    const root = await doc.get(doc.trailer.get('Root'));
    return doc.get(root.get('OCProperties'));
  };

  test('сжатие сохраняет слои; выключенный по умолчанию остаётся выключенным', async () => {
    const r = await compressPdf(ocPdf('A'), 1e9);
    const doc = await openDoc(r.blob);
    const oc = await props(doc);
    assert.ok(isDict(oc), 'OCProperties на месте');
    const d = await doc.get(oc.get('D'));
    assert.deepEqual(await layerNames(doc, await doc.get(oc.get('OCGs'))), ['A-visible', 'A-hidden']);
    assert.deepEqual(await layerNames(doc, d.get('OFF')), ['A-hidden']);
    assert.deepEqual(await layerNames(doc, d.get('ON')), ['A-visible']);
  });

  test('объединение складывает слои двух файлов; OFF, ON и Order объединены; у страниц ссылки на эти слои', async () => {
    const r = await mergePdfs([ocPdf('A'), ocPdf('B')]);
    const doc = await openDoc(r.blob);
    const oc = await props(doc);
    const d = await doc.get(oc.get('D'));
    const all = await doc.get(oc.get('OCGs'));
    assert.deepEqual(await layerNames(doc, all), ['A-visible', 'A-hidden', 'B-visible', 'B-hidden']);
    assert.deepEqual(await layerNames(doc, d.get('OFF')), ['A-hidden', 'B-hidden']);
    assert.deepEqual(await layerNames(doc, d.get('ON')), ['A-visible', 'B-visible']);
    assert.deepEqual(await layerNames(doc, d.get('Order')), ['A-visible', 'A-hidden', 'B-visible', 'B-hidden']);
    const nums = new Set(all.map(x => x.num));
    for (const p of doc.pageRefs) {
      const res = await doc.get(p.dict.get('Resources'));
      const pr = await doc.get(res.get('Properties'));
      for (const v of pr.values()) assert.ok(nums.has(v.num), 'слой страницы входит в OCGs');
    }
  });

  test('если слоёв нет ни в одном файле, OCProperties не появляется; слои есть только в одном файле — сохраняются', async () => {
    const none = await openDoc((await mergePdfs([fx('text'), fx('objstm')])).blob);
    assert.equal((await doc2root(none)).has('OCProperties'), false);
    const one = await openDoc((await mergePdfs([fx('text'), ocPdf('A')])).blob);
    assert.equal((await doc2root(one)).has('OCProperties'), true);
  });
  const doc2root = async doc => doc.get(doc.trailer.get('Root'));
});

describe('9. кэш сериализации Writer', () => {
  const stream = (raw, extra = []) => new Stream(new Map([['Type', name('X')], ...extra]), raw);
  const build = (w, root) => w.toBlob(root, null);
  // у этих файлов нет страниц, поэтому читаем только таблицу ссылок
  const low = async bytes => { const d = new PdfDoc(new Uint8Array(bytes)); await d.readXrefChain(); return d; };

  test('новый объект на том же номере между сборками не берётся из кэша', async () => {
    const w = new Writer();
    const cat = w.add(new Map([['Type', name('Catalog')]]));
    const n = w.alloc();
    w.set(n, stream(Buffer.from('первый вариант')));
    const a = latin1(await blobBytes(build(w, cat)));
    w.set(n, stream(Buffer.from('второй, другой длины вариант')));
    const b = latin1(await blobBytes(build(w, cat)));
    assert.match(a, /stream\n\xd0\xbf/); // «п» в UTF-8
    assert.ok(!b.includes(Buffer.from('первый вариант').toString('latin1')), 'старые данные остались');
    assert.ok(b.includes(Buffer.from('второй, другой длины вариант').toString('latin1')));
    const doc = await low(Buffer.from(b, 'latin1'));
    const s = await doc.get(new Ref(n, 0));
    assert.equal(s.dict.get('Length'), Buffer.from('второй, другой длины вариант').length);
  });

  test('два варианта на копиях Writer (как при подборе уровней): оба корректны и различны, xref верна', async () => {
    const base = new Writer();
    const cat = base.add(new Map([['Type', name('Catalog')]]));
    const shared = base.add(stream(Buffer.from('общий объект')));
    const var1 = base.alloc();
    const make = raw => { const c = new Writer(); c.objs = base.objs.slice(); c.set(var1, stream(Buffer.from(raw))); return c; };
    const A = await blobBytes(build(make('вариант А'), cat));
    const B = await blobBytes(build(make('вариант Б, подлиннее'), cat));
    assert.notDeepEqual(A, B);
    for (const [bytes, text] of [[A, 'вариант А'], [B, 'вариант Б, подлиннее']]) {
      const doc = await low(bytes);
      assert.deepEqual(Buffer.from((await doc.get(new Ref(var1, 0))).raw), Buffer.from(text));
      assert.deepEqual(Buffer.from((await doc.get(shared)).raw), Buffer.from('общий объект'));
      // смещения в xref совпадают с настоящими
      const s = latin1(bytes);
      const x = +/startxref\s+(\d+)/.exec(s)[1];
      const rows = s.slice(x).split("\n").slice(3, 3 + 3);
      rows.forEach((row, i) => assert.ok(s.startsWith(`${i + 1} 0 obj`, +row.slice(0, 10)), `объект ${i + 1}`));
    }
  });

  test('один объект, поставленный на другой номер: заголовок «N 0 obj» с новым номером', async () => {
    const w = new Writer();
    const cat = w.add(new Map([['Type', name('Catalog')]]));
    const obj = stream(Buffer.from('x'.repeat(40)));
    const a = w.add(obj), b = w.alloc();
    await blobBytes(build(w, cat)); // кладём в кэш под номером a
    w.set(b, obj);
    const bytes = await blobBytes(build(w, cat));
    const doc = await low(bytes);
    assert.equal((await doc.get(new Ref(b, 0))).raw.length, 40);
    assert.equal(a.num, 2);
  });

  test('сжатие дважды подряд одного файла: результаты идентичны и корректны', async () => {
    const x = await blobBytes((await compressPdf(fx('images'), 1e9)).blob);
    const y = await blobBytes((await compressPdf(fx('images'), 1e9)).blob);
    assert.deepEqual(x, y);
    assert.equal((await PdfDoc.load(x)).pageRefs.length, 11);
  });
});

describe('10. строки UTF-16 в pdf.js и pdftools.js', () => {
  const jpeg = (w, h) => new Blob([Uint8Array.from([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0, 0xFF, 0xD9])]);

  test('utf16be: BOM, кириллица, суррогатные пары, пустая строка', () => {
    assert.deepEqual([...pdfjs.utf16be('')], [0xFE, 0xFF]);
    assert.deepEqual([...pdfjs.utf16be('Я')], [0xFE, 0xFF, 0x04, 0x2F]);
    assert.deepEqual([...pdfjs.utf16be('😀')], [0xFE, 0xFF, 0xD8, 0x3D, 0xDE, 0x00]);
    assert.deepEqual([...textStr('Я😀').bytes], [...pdfjs.utf16be('Я😀')]);
  });

  test('экспорт: название с кириллицей и эмодзи записано в /Title прописными шестнадцатеричными цифрами, как раньше', async () => {
    const title = 'Договор №5 — копия 😀';
    const s = latin1(await blobBytes(await pdfjs.buildPdf([jpeg(30, 40)], { title })));
    const m = /\/Title <([0-9A-F]+)>/.exec(s);
    assert.ok(m, 'Title записан шестнадцатеричной строкой в верхнем регистре');
    assert.equal(Buffer.from(m[1], 'hex').subarray(2).swap16().toString('utf16le'), title);
    assert.ok(m[1].startsWith('FEFF'));
    assert.match(s, /\/Producer <FEFF[0-9A-F]+>/);
  });

  test('экспорт: по умолчанию название «Скан»; страница, Producer и дата на месте', async () => {
    const s = latin1(await blobBytes(await pdfjs.buildPdf([jpeg(30, 40), jpeg(40, 30)], {})));
    const m = /\/Title <([0-9A-F]+)>/.exec(s);
    assert.equal(Buffer.from(m[1], 'hex').subarray(2).swap16().toString('utf16le'), 'Скан');
    assert.match(s, /\/CreationDate \(D:\d{14}\)/);
    assert.match(s, /\/Count 2/);
  });
});
