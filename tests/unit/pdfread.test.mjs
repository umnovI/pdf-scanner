// Модуль pdfread.js: разбор чужих PDF (запускается прямо в Node — модуль без обращений к DOM).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PdfDoc, PdfError, Ref, Stream, ascii85Encode, decodeStream, fx, handPdf, isDict, isName, latin1, manifest,
  loadInWorker, pageContent, pageGeom, pageMarks,
} from '../pdfutil.mjs';
import { asciiHex, ascii85, name, unpredict } from '../../app/pdfread.js';

const TEXT_BOXES = [[0, 0, 595, 842], [0, 0, 612, 792], [0, 0, 595, 420]];

describe('открытие файлов разной упаковки', () => {
  for (const f of ['text', 'objstm', 'linearized', 'shifted', 'bad-startxref', 'junk-prefix', 'truncated']) {
    test(`${f}.pdf: три страницы по порядку, размеры и метки`, async () => {
      const doc = await PdfDoc.load(fx(f));
      assert.equal(doc.pageRefs.length, 3);
      assert.deepEqual(await pageMarks(doc), manifest[f + '.pdf'].marks);
      const boxes = [];
      for (const p of doc.pageRefs) boxes.push((await pageGeom(doc, p)).box);
      assert.deepEqual(boxes, TEXT_BOXES);
    });
  }

  test('текстовый поток reportlab (ASCII85 + Flate) распаковывается в команды страницы', async () => {
    const doc = await PdfDoc.load(fx('text'));
    const c = await pageContent(doc, doc.pageRefs[0]);
    assert.match(c, /\(TEXT-P1\) Tj/);
    assert.match(c, /BT\b/);
  });

  test('сжатая таблица и потоки объектов (PDF 1.5): объекты находятся, страницы читаются', async () => {
    const bytes = fx('objstm');
    assert.match(latin1(bytes), /\/Type\s*\/XRef/, 'в фикстуре должна быть сжатая таблица');
    assert.match(latin1(bytes), /\/Type\s*\/ObjStm/, 'в фикстуре должны быть потоки объектов');
    const doc = await PdfDoc.load(bytes);
    assert.ok([...doc.xref.values()].some(e => e.type === 2), 'есть объекты внутри потоков');
    assert.deepEqual(await pageMarks(doc), ['TEXT-P1', 'TEXT-P2', 'TEXT-P3']);
  });

  test('гибридный файл: таблица + /XRefStm — страницы из потока объектов находятся', async () => {
    const doc = await PdfDoc.load(fx('hybrid'));
    assert.deepEqual(await pageMarks(doc), ['HYB-P1']);
    assert.deepEqual((await pageGeom(doc, doc.pageRefs[0])).box, [0, 0, 400, 500]);
  });

  test('гибридный файл, где объекты потока помечены в таблице свободными (f): записи /XRefStm их перекрывают', async () => {
    const bytes = fx('hybrid-free');
    const t = latin1(bytes);
    assert.match(t, /\n0000000000 00000 f \n0000000000 00000 f \n/, 'в таблице объекты 2 и 3 свободны');
    assert.match(t, /\/XRefStm \d+/);
    const orig = PdfDoc.prototype.rebuildXref;
    let rebuilt = 0;
    PdfDoc.prototype.rebuildXref = function (...a) { rebuilt++; return orig.apply(this, a); };
    try {
      const doc = await PdfDoc.load(bytes);
      assert.equal(rebuilt, 0, 'читается по таблицам, не через восстановление');
      assert.deepEqual(await pageMarks(doc), ['HYB-P1']);
      assert.deepEqual((await pageGeom(doc, doc.pageRefs[0])).box, [0, 0, 400, 500]);
      assert.equal(doc.xref.get(3).type, 2);
    } finally { PdfDoc.prototype.rebuildXref = orig; }
  });

  test('инкрементальное обновление: берётся новая ревизия (/Rotate 90), остальное — из старой', async () => {
    const doc = await PdfDoc.load(fx('incremental'));
    assert.deepEqual(await Promise.all(doc.pageRefs.map(async p => (await pageGeom(doc, p)).rotate)), [90, 0, 0]);
    assert.deepEqual(await pageMarks(doc), ['TEXT-P1', 'TEXT-P2', 'TEXT-P3']);
    // контроль фикстуры: в старой ревизии поворота не было
    assert.equal((await pageGeom(await PdfDoc.load(fx('text')), (await PdfDoc.load(fx('text'))).pageRefs[0])).rotate, 0);
  });

  test('Resources, MediaBox и Rotate наследуются от /Pages; собственные значения страницы главнее', async () => {
    const doc = await PdfDoc.load(fx('inherited'));
    const g = [];
    for (const p of doc.pageRefs) g.push(await pageGeom(doc, p));
    assert.deepEqual(g.map(x => x.box), manifest['inherited.pdf'].mediaBoxes);
    assert.deepEqual(g.map(x => x.rotate), [180, 90, 180]);
    assert.ok(doc.pageRefs.every(p => !p.dict.has('Resources')), 'в самой странице ресурсов нет');
    assert.ok(doc.pageRefs.every(p => isDict(p.inherited.Resources)), '…но они унаследованы');
  });

  test('исправные файлы читаются по таблицам ссылок (с /Prev и /XRefStm), а не через восстановление; битые — через него', async () => {
    const orig = PdfDoc.prototype.rebuildXref;
    let rebuilt = 0;
    PdfDoc.prototype.rebuildXref = function (...a) { rebuilt++; return orig.apply(this, a); };
    try {
      const used = async f => { rebuilt = 0; await PdfDoc.load(fx(f)); return rebuilt > 0; };
      for (const f of ['text', 'objstm', 'linearized', 'incremental', 'hybrid', 'hybrid-free', 'inherited', 'link', 'images']) {
        assert.equal(await used(f), false, `${f}.pdf не должен требовать восстановления`);
      }
      for (const f of ['bad-startxref', 'shifted', 'truncated']) {
        assert.equal(await used(f), true, `${f}.pdf читается только через восстановление`);
      }
    } finally { PdfDoc.prototype.rebuildXref = orig; }
  });

  test('битая ссылка на таблицу: восстановление по тексту «N G obj» находит те же страницы', async () => {
    const good = await PdfDoc.load(fx('text'));
    const bad = await PdfDoc.load(fx('bad-startxref'));
    assert.deepEqual(bad.pageRefs.map(p => p.ref.num), good.pageRefs.map(p => p.ref.num));
  });

  test('одно и то же открытие дважды даёт разные номера документов (нужно для объединения)', async () => {
    const a = await PdfDoc.load(fx('text')), b = await PdfDoc.load(fx('text'));
    assert.notEqual(a.id, b.id);
  });

  test('Uint8Array из середины большого буфера и ArrayBuffer открываются одинаково', async () => {
    const src = fx('text');
    const big = new Uint8Array(src.length + 100);
    big.set(src, 50);
    const doc = await PdfDoc.load(big.subarray(50, 50 + src.length));
    assert.equal(doc.pageRefs.length, 3);
    const doc2 = await PdfDoc.load(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
    assert.equal(doc2.pageRefs.length, 3);
  });
});

describe('ошибки с понятным текстом', () => {
  const rejects = async (bytes, re) => {
    await assert.rejects(PdfDoc.load(bytes), e => {
      assert.ok(e instanceof PdfError, `ожидали PdfError, получили ${e?.constructor?.name}: ${e?.message}`);
      assert.match(e.message, re);
      return true;
    });
  };

  test('зашифрованный PDF (пустой пароль): «зашифрован»', () => rejects(fx('encrypted'), /зашифр/));
  test('зашифрованный AES-256 со сжатой таблицей: «зашифрован», а не «повреждён»', () => rejects(fx('encrypted-objstm'), /зашифр/));
  test('не PDF: случайные байты', () => rejects(new Uint8Array([1, 2, 3, 4, 5]), /не PDF/));
  test('пустой файл', () => rejects(new Uint8Array(0), /не PDF/));
  test('текстовый файл', () => rejects(new TextEncoder().encode('Привет, это обычный текст, а не PDF'), /не PDF/));
  test('картинка PNG, переименованная в .pdf', () => rejects(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]), /не PDF/));
  test('PDF без страниц: «нет страниц»', () => rejects(handPdf([]), /нет страниц/));
  test('только заголовок %PDF-1.4 без содержимого: PdfError, а не TypeError', async () => {
    await assert.rejects(PdfDoc.load(new TextEncoder().encode('%PDF-1.4\n')), e => e instanceof PdfError);
  });
  test('заголовок после 1 КБ мусора не считается PDF', () => rejects(new Uint8Array([...new Uint8Array(2000).fill(65), ...fx('text')]), /не PDF/));

  test('каталог без /Pages: «нет страниц» или «повреждён», но PdfError', async () => {
    const bytes = handPdf([{ text: 'A' }]);
    const broken = new TextEncoder().encode(latin1(bytes).replace('/Pages 2 0 R', '/Pages 99 0 R'));
    await assert.rejects(PdfDoc.load(broken), e => e instanceof PdfError);
  });
});

describe('устойчивость к повреждениям', () => {
  // Детерминированный генератор для повторяемости.
  const lcg = seed => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

  /** Проверка одного повреждённого файла: не висит, не падает не-PdfError; возвращает описание проблемы или null. */
  const problem = async (label, bytes, maxPages = 3) => {
    const r = await loadInWorker(bytes, 2000);
    if (r.hang) return `${label}: разбор завис`;
    if (r.error && r.error.type !== 'PdfError') return `${label}: ${r.error.type}: ${r.error.message}`;
    if (r.pages !== undefined && (r.pages < 1 || r.pages > maxPages)) return `${label}: ${r.pages} страниц`;
    return null;
  };

  test('обрезка файла в разных местах: либо PdfError, либо страницы; без зависаний и TypeError', async () => {
    const bad = [];
    for (const f of ['text', 'objstm', 'incremental']) {
      const src = fx(f);
      for (let i = 1; i <= 12; i++) {
        const cut = Math.floor((src.length * i) / 13);
        const p = await problem(`${f} обрезан на ${cut}`, src.slice(0, cut));
        if (p) bad.push(p);
      }
    }
    assert.deepEqual(bad, []);
  });

  test('случайные испорченные байты (15 вариантов): без зависаний и ошибок, кроме PdfError', async () => {
    const rnd = lcg(7);
    const src = fx('text');
    const bad = [];
    for (let k = 0; k < 15; k++) {
      const b = src.slice();
      for (let j = 0; j < 8; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      const p = await problem(`вариант ${k}`, b);
      if (p) bad.push(p);
    }
    assert.deepEqual(bad, []);
  });

  test('мусорный символ-разделитель в таблице xref не зависает разбор (восстановление по «N G obj»)', async () => {
    // «0000000199» → «000[000199»: слово обрывается на «[», счётчик подраздела становится 0
    const s = latin1(fx('text')).replace(/0000000199 00000 n/, '000[000199 00000 n');
    const r = await loadInWorker(Buffer.from(s, 'latin1'), 3000);
    assert.ok(!r.hang, 'разбор завис (бесконечный цикл в readXrefAt)');
    assert.equal(r.pages, 3);
  });

  test('цикл /Prev: ссылка таблицы на саму себя не зацикливает чтение', async () => {
    const bytes = fx('text');
    const s = latin1(bytes);
    const x = +/startxref\s+(\d+)/.exec(s)[1];
    const looped = s.replace(/trailer\s*<<([^>]*)>>/, (m, body) => `trailer\n<<${body} /Prev ${x} >>`);
    const doc = await PdfDoc.load(new Uint8Array(Buffer.from(looped, 'latin1')));
    assert.equal(doc.pageRefs.length, 3);
  });

  test('дерево страниц с циклом (Kids указывает на родителя): конечное число страниц', async () => {
    const bytes = handPdf([{ text: 'A' }, { text: 'B' }]);
    const s = latin1(bytes).replace('/Kids [3 0 R 5 0 R]', '/Kids [3 0 R 2 0 R 5 0 R]');
    const doc = await PdfDoc.load(new Uint8Array(Buffer.from(s, 'latin1')));
    assert.equal(doc.pageRefs.length, 2);
  });

  test('одна и та же страница в Kids дважды считается один раз', async () => {
    const s = latin1(handPdf([{ text: 'A' }, { text: 'B' }])).replace('/Kids [3 0 R 5 0 R]', '/Kids [3 0 R 3 0 R 5 0 R]');
    const doc = await PdfDoc.load(new Uint8Array(Buffer.from(s, 'latin1')));
    assert.equal(doc.pageRefs.length, 2);
  });

  test('вложенное дерево /Pages (три уровня) читается по порядку', async () => {
    const mk = (n, kids, parent) => `<< /Type /Pages /Kids [${kids}] /Count 1 ${parent ? `/Parent ${parent} 0 R` : ''} >>`;
    const page = (txt, parent, c) => `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 100 100] /Contents ${c} 0 R >>`;
    const stream = t => ({ dict: '', data: Buffer.from(`BT (${t}) Tj ET`) });
    const bytes = handPdf([{ text: 'X' }], {
      extraObjs: {
        2: mk(2, '10 0 R 11 0 R'), 10: mk(10, '12 0 R', 2), 11: mk(11, '13 0 R', 2),
        12: page('1', 10, 14), 13: page('2', 11, 15), 14: stream('(L1)'), 15: stream('(L2)'),
      },
    });
    const doc = await PdfDoc.load(bytes);
    assert.deepEqual(doc.pageRefs.map(p => p.ref.num), [12, 13]);
  });

  test('Length потока неверный (короче, длиннее, ссылка в никуда): данные берутся по endstream', async () => {
    const content = 'BT /F1 20 Tf 50 100 Td (LEN-P1) Tj ET';
    for (const len of ['3', '9999', '77 0 R']) {
      const s = latin1(handPdf([{ text: 'LEN-P1' }])).replace(/\/Length \d+/, `/Length ${len}`);
      const doc = await PdfDoc.load(new Uint8Array(Buffer.from(s, 'latin1')));
      assert.equal((await pageContent(doc, doc.pageRefs[0])).trim(), content, `Length ${len}`);
    }
  });

  test('Length — косвенный объект: используется', async () => {
    const content = 'BT (X) Tj ET';
    const bytes = handPdf([{ content }], { extraObjs: { 20: String(content.length) } });
    const s = latin1(bytes).replace(/(4 0 obj\n<< )\/Length \d+/, '$1/Length 20 0 R');
    const doc = await PdfDoc.load(new Uint8Array(Buffer.from(s, 'latin1')));
    assert.equal((await pageContent(doc, doc.pageRefs[0])).trim(), content);
  });

  test('конец строки CRLF после «stream»', async () => {
    const s = latin1(handPdf([{ content: 'BT (CR) Tj ET' }])).replace('stream\nBT', 'stream\r\nBT');
    // смещения в xref сдвинулись — сработает восстановление
    const doc = await PdfDoc.load(new Uint8Array(Buffer.from(s, 'latin1')));
    assert.equal((await pageContent(doc, doc.pageRefs[0])).trim(), 'BT (CR) Tj ET');
  });
});

describe('значения PDF (лексер)', () => {
  const read = async body => {
    const doc = await PdfDoc.load(handPdf([{ text: 'A' }], { extraObjs: { 30: body } }));
    return doc.get(new Ref(30, 0));
  };

  test('строки: экранирование, вложенные скобки, восьмеричные коды, перенос строки', async () => {
    const v = await read(String.raw`[(a\(b\)c) (x(y)z) (\101\102\7) (l\
ine) (\n\t) <48656C6C6F> <7>]`);
    const s = v.map(x => Buffer.from(x.bytes).toString('latin1'));
    assert.deepEqual(s, ['a(b)c', 'x(y)z', 'AB\x07', 'line', '\n\t', 'Hello', 'p']);
  });

  test('имена: #-коды и пустое имя; комментарии внутри словаря пропускаются', async () => {
    const d = await read('<< /A#20B 1 % комментарий\n /C /D#2FE /E / >>');
    assert.equal(d.get('A B'), 1);
    assert.ok(isName(d.get('C'), 'D/E'));
    assert.ok(isName(d.get('E'), ''));
  });

  test('числа: знак, дробные, ссылки «n g R» против двух чисел подряд', async () => {
    const a = await read('[-1 +2 3.5 .5 4. 5 0 R 6 7]');
    assert.deepEqual(a.slice(0, 5), [-1, 2, 3.5, 0.5, 4]);
    assert.ok(a[5] instanceof Ref && a[5].num === 5);
    assert.deepEqual(a.slice(6), [6, 7]);
  });

  test('true/false/null и вложенные словари', async () => {
    const d = await read('<< /T true /F false /N null /D << /X [1 [2 [3]]] >> >>');
    assert.equal(d.get('T'), true); assert.equal(d.get('F'), false); assert.equal(d.get('N'), null);
    assert.deepEqual(d.get('D').get('X'), [1, [2, [3]]]);
  });

  test('глубина вложенности свыше 200 даёт PdfError, а не переполнение стека', async () => {
    const doc = await PdfDoc.load(handPdf([{ text: 'A' }], { extraObjs: { 30: '['.repeat(5000) + ']'.repeat(5000) } }));
    // битый объект считается отсутствующим (get возвращает null)
    assert.equal(await doc.get(new Ref(30, 0)), null);
  });
});

describe('фильтры потоков', () => {
  test('ascii85: круговая проверка на разной длине, с «z» и пробелами', () => {
    for (let n = 0; n <= 23; n++) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      assert.deepEqual([...ascii85(new TextEncoder().encode(ascii85Encode(data)))], [...data], `длина ${n}`);
    }
    const zeros = new Uint8Array(12);
    assert.match(ascii85Encode(zeros), /^zzz~>$/);
    assert.deepEqual([...ascii85(new TextEncoder().encode('z z\nz~>'))], [...zeros]);
    const spaced = ascii85Encode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7])).replace(/(.)/g, '$1 \n');
    assert.deepEqual([...ascii85(new TextEncoder().encode(spaced))], [1, 2, 3, 4, 5, 6, 7]);
  });

  test('ascii85: известный пример и мусор после ~>', () => {
    assert.equal(Buffer.from(ascii85(new TextEncoder().encode('87cURD]i,"Ebo80~>junk'))).toString(), 'Hello World!');
    assert.equal(ascii85(new TextEncoder().encode('~>')).length, 0);
  });

  test('ascii85: недопустимый символ — PdfError', () => {
    assert.throws(() => ascii85(new TextEncoder().encode('87cUÿD')), PdfError);
    assert.throws(() => ascii85(new TextEncoder().encode('abcd{')), PdfError);
  });

  test('asciiHex: пробелы, регистр, нечётное число цифр, конец по «>»', () => {
    assert.equal(Buffer.from(asciiHex(new TextEncoder().encode('48 65 6c6C 6F>garbage'))).toString(), 'Hello');
    assert.deepEqual([...asciiHex(new TextEncoder().encode('7>'))], [0x70]);
    assert.deepEqual([...asciiHex(new TextEncoder().encode('>'))], []);
  });

  // Эталонный кодировщик PNG-предикторов (каждая строка своим типом).
  const pngEncode = (raw, row, bpp) => {
    const rows = raw.length / row;
    const out = [];
    for (let r = 0; r < rows; r++) {
      const type = r % 5;
      out.push(type);
      for (let i = 0; i < row; i++) {
        const x = raw[r * row + i];
        const a = i >= bpp ? raw[r * row + i - bpp] : 0;
        const b = r ? raw[(r - 1) * row + i] : 0;
        const c = r && i >= bpp ? raw[(r - 1) * row + i - bpp] : 0;
        let p = 0;
        if (type === 1) p = a; else if (type === 2) p = b; else if (type === 3) p = (a + b) >> 1;
        else if (type === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        out.push((x - p) & 255);
      }
    }
    return Uint8Array.from(out);
  };

  test('unpredict: все пять типов строк PNG (RGB 8 бит) восстанавливают исходные данные', () => {
    const cols = 7, row = cols * 3;
    const raw = Uint8Array.from({ length: row * 10 }, (_, i) => (i * 131 + (i >> 3) * 17) & 255);
    const parms = new Map([['Predictor', 15], ['Colors', 3], ['BitsPerComponent', 8], ['Columns', cols]]);
    assert.deepEqual([...unpredict(pngEncode(raw, row, 3), parms)], [...raw]);
  });

  test('unpredict: 1 бит на пиксель и 16 бит', () => {
    for (const [colors, bpc, cols] of [[1, 1, 21], [1, 16, 5], [4, 8, 3]]) {
      const row = Math.ceil((colors * bpc * cols) / 8), bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
      const raw = Uint8Array.from({ length: row * 6 }, (_, i) => (i * 73 + 11) & 255);
      const parms = new Map([['Predictor', 12], ['Colors', colors], ['BitsPerComponent', bpc], ['Columns', cols]]);
      assert.deepEqual([...unpredict(pngEncode(raw, row, bpp), parms)], [...raw], `${colors}x${bpc}x${cols}`);
    }
  });

  test('unpredict: Predictor 1 — данные как есть; Predictor 2 (TIFF) — понятная ошибка', () => {
    const d = Uint8Array.from([1, 2, 3]);
    assert.equal(unpredict(d, new Map([['Predictor', 1]])), d);
    assert.equal(unpredict(d, undefined), d);
    assert.throws(() => unpredict(d, new Map([['Predictor', 2]])), PdfError);
  });

  test('decodeStream: Flate+предиктор, цепочка ASCII85→Flate, остановка на DCT', async () => {
    const zlib = await import('node:zlib');
    const resolve = v => v;
    const payload = Buffer.from('Привет, PDF! '.repeat(50));
    const chain = new Stream(new Map([['Filter', [name('ASCII85Decode'), name('FlateDecode')]]]),
      new TextEncoder().encode(ascii85Encode(zlib.deflateSync(payload))));
    const r = await decodeStream(chain, new Set(), resolve);
    assert.equal(Buffer.from(r.data).toString(), payload.toString());
    assert.equal(r.filters.length, 0);

    const jpeg = Uint8Array.from([0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9]);
    const img = new Stream(new Map([['Filter', [name('ASCII85Decode'), name('DCTDecode')]]]), new TextEncoder().encode(ascii85Encode(jpeg)));
    const r2 = await decodeStream(img, new Set(), resolve);
    assert.deepEqual([...r2.data], [...jpeg]);
    assert.deepEqual(r2.filters.map(f => f.n), ['DCTDecode']);

    const stopAtFlate = await decodeStream(chain, new Set(['FlateDecode']), resolve);
    assert.deepEqual(stopAtFlate.filters.map(f => f.n), ['FlateDecode']);
    assert.deepEqual([...stopAtFlate.data], [...zlib.deflateSync(payload)]);
  });

  test('decodeStream: поток Flate без контрольной суммы и «сырой» deflate распаковываются', async () => {
    const zlib = await import('node:zlib');
    const payload = Buffer.from('abc'.repeat(100));
    const noSum = zlib.deflateSync(payload).subarray(0, -4); // без Adler-32
    const raw = zlib.deflateRawSync(payload);
    for (const data of [noSum, raw]) {
      const r = await decodeStream(new Stream(new Map([['Filter', name('FlateDecode')]]), data), new Set(), v => v);
      assert.equal(Buffer.from(r.data).toString(), payload.toString());
    }
  });

  test('decodeStream: повреждённый Flate — PdfError', async () => {
    await assert.rejects(decodeStream(new Stream(new Map([['Filter', name('FlateDecode')]]), new Uint8Array(8).fill(0xFF)), new Set(), v => v), PdfError);
  });
});

describe('stripExif (pdftools.js)', () => {
  test('убирает блок APP1 Exif, остальные сегменты и данные не трогает; без Exif — те же байты', async () => {
    const { stripExif } = await import('../../app/pdftools.js');
    const app0 = [0xFF, 0xE0, 0, 4, 1, 2];
    const exif = [0xFF, 0xE1, 0, 10, 0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2]; // длина 10 включая 2 байта длины
    const xmp = [0xFF, 0xE1, 0, 8, 0x68, 0x74, 0x74, 0x70, 0, 0];        // APP1, но не Exif
    const tail = [0xFF, 0xDA, 0, 2, 9, 9, 9, 0xFF, 0xD9];
    const mk = (...parts) => Uint8Array.from([0xFF, 0xD8, ...parts.flat()]);
    assert.deepEqual([...stripExif(mk(app0, exif, xmp, tail))], [...mk(app0, xmp, tail)]);
    assert.deepEqual([...stripExif(mk(exif, exif, tail))], [...mk(tail)], 'несколько блоков');
    const plain = mk(app0, xmp, tail);
    assert.equal(stripExif(plain), plain, 'без Exif возвращается тот же массив');
    const notJpeg = Uint8Array.from([1, 2, 3]);
    assert.equal(stripExif(notJpeg), notJpeg);
    assert.equal(stripExif(new Uint8Array(0)).length, 0);
    // «Exif» внутри данных изображения после SOS не ищется
    const tricky = mk(app0, [0xFF, 0xDA, 0, 2], exif);
    assert.deepEqual([...stripExif(tricky)], [...tricky]);
  });
});
