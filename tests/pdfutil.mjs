// Помощники для проверок PDF: разбор результата собственным читалкой приложения (в Node),
// тестовые PDF из tests/fixtures/pdf и сборка маленьких PDF «вручную».
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { FIXTURES, parsePdf } from './helpers.mjs';
import { PdfDoc, PdfError, Ref, Stream, decodeStream, isDict, isName } from '../app/pdfread.js';

export { PdfDoc, PdfError, Ref, Stream, decodeStream, isDict, isName, parsePdf };

export const PDF_DIR = path.join(FIXTURES, 'pdf');
export const pdfFile = name => path.join(PDF_DIR, name + '.pdf');
/** Байты тестового PDF (Uint8Array). */
export const fx = name => new Uint8Array(fs.readFileSync(pdfFile(name)));
export const manifest = JSON.parse(fs.readFileSync(path.join(PDF_DIR, 'manifest.json'), 'utf8'));

export const blobBytes = async blob => new Uint8Array(await blob.arrayBuffer());
export const latin1 = u => Buffer.from(u).toString('latin1');

/** Содержимое страницы (распакованные потоки Contents) как строка. */
export async function pageContent(doc, page) {
  let c = await doc.get(page.dict.get('Contents'));
  const list = Array.isArray(c) ? c : [page.dict.get('Contents')];
  let out = '';
  for (const r of list) {
    const s = await doc.get(r);
    if (s instanceof Stream) out += latin1(await doc.decode(s)) + '\n';
  }
  return out;
}

/** Текстовые метки (TEXT-P1, IMG-P2, …) страниц по порядку: строки в скобках вида «(МЕТКА) Tj». */
export async function pageMarks(doc) {
  const out = [];
  for (const p of doc.pageRefs) {
    const m = /\(([A-Z0-9]+-P\d+)\)\s*Tj/.exec(await pageContent(doc, p));
    out.push(m ? m[1] : null);
  }
  return out;
}

/** Число /Rotate и MediaBox страницы с учётом наследования. */
export async function pageGeom(doc, page) {
  const g = async k => doc.get(page.dict.has(k) ? page.dict.get(k) : page.inherited[k]);
  const box = await g('MediaBox');
  const rot = await g('Rotate');
  return { box: box ? await Promise.all(box.map(v => doc.get(v))) : null, rotate: typeof rot === 'number' ? rot : 0 };
}

/** Открывает байты или Blob. */
export async function openDoc(src) {
  return PdfDoc.load(src instanceof Blob ? await blobBytes(src) : src);
}

/** Все объекты файла, на которые не ссылается никто (проверка «не тянем лишнего»): число объектов в таблице. */
export const objectCount = bytes => {
  const s = latin1(bytes);
  return +/xref\n0 (\d+)\n/.exec(s)[1];
};

/** Таблица ссылок и заголовок корректны (смещения, startxref, %%EOF). */
export function assertValidPdf(bytes, assert, what = 'PDF') {
  const r = parsePdf(Buffer.from(bytes));
  assert.deepEqual(r.errors, [], `${what}: ошибки структуры`);
  return r;
}

// ---------- Сборка PDF «вручную» (для краевых случаев) ----------

export function ascii85Encode(data) {
  let out = '';
  for (let i = 0; i < data.length; i += 4) {
    const n = Math.min(4, data.length - i);
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (k < n ? data[i + k] : 0);
    if (n === 4 && v === 0) { out += 'z'; continue; }
    const c = [];
    for (let k = 0; k < 5; k++) { c.unshift(String.fromCharCode(33 + (v % 85))); v = Math.floor(v / 85); }
    out += c.slice(0, n + 1).join('');
  }
  return out + '~>';
}

/**
 * Простой PDF из страниц: pages = [{ text, box, extra, content }], objs — дополнительные объекты
 * {num: 'тело'} (строки или { dict, data }). Возвращает Uint8Array с корректной таблицей xref.
 */
export function handPdf(pages, { extraObjs = {}, catalogExtra = '', trailerExtra = '' } = {}) {
  const parts = [];
  const objs = new Map();
  const n = pages.length;
  objs.set(1, `<< /Type /Catalog /Pages 2 0 R ${catalogExtra} >>`);
  objs.set(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + 2 * i} 0 R`).join(' ')}] /Count ${n} >>`);
  pages.forEach((p, i) => {
    const content = p.content ?? `BT /F1 20 Tf 50 100 Td (${p.text}) Tj ET`;
    objs.set(3 + 2 * i, `<< /Type /Page /Parent 2 0 R /MediaBox [${(p.box || [0, 0, 300, 200]).join(' ')}] ` +
      `/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>${p.xobjects ? ` /XObject << ${Object.entries(p.xobjects).map(([k, v]) => `/${k} ${v} 0 R`).join(' ')} >>` : ''}${p.resExtra || ''} >> /Contents ${4 + 2 * i} 0 R ${p.extra || ''} >>`);
    objs.set(4 + 2 * i, { dict: '', data: Buffer.from(content, 'latin1') });
  });
  for (const [k, v] of Object.entries(extraObjs)) objs.set(+k, v);
  let out = Buffer.from('%PDF-1.4\n');
  const offs = [];
  const max = Math.max(...objs.keys());
  for (let k = 1; k <= max; k++) {
    if (!objs.has(k)) continue;
    offs[k] = out.length;
    const v = objs.get(k);
    const body = typeof v === 'string'
      ? Buffer.from(`${k} 0 obj\n${v}\nendobj\n`, 'latin1')
      : Buffer.concat([Buffer.from(`${k} 0 obj\n<< ${v.dict} /Length ${v.data.length} >>\nstream\n`, 'latin1'), v.data, Buffer.from('\nendstream\nendobj\n')]);
    out = Buffer.concat([out, body]);
  }
  const x = out.length;
  let t = `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let k = 1; k <= max; k++) t += offs[k] === undefined ? '0000000000 65535 f \n' : `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  t += `trailer\n<< /Size ${max + 1} /Root 1 0 R ${trailerExtra} >>\nstartxref\n${x}\n%%EOF\n`;
  return new Uint8Array(Buffer.concat([out, Buffer.from(t, 'latin1')]));
}

export const deflateSync = data => zlib.deflateSync(data);

// ---------- Разбор в отдельном потоке (чтобы зависание не повесило весь набор тестов) ----------
import { Worker } from 'node:worker_threads';
const READ_URL = new URL('../app/pdfread.js', import.meta.url).href;

/**
 * Открывает PDF в рабочем потоке с ограничением по времени.
 * @returns {Promise<{ hang?: true, pages?: number, error?: { type: string, message: string } }>}
 */
export function loadInWorker(bytes, ms = 5000) {
  return new Promise(resolve => {
    const w = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      import(workerData.url).then(async m => {
        try {
          const d = await m.PdfDoc.load(workerData.bytes);
          parentPort.postMessage({ pages: d.pageRefs.length });
        } catch (e) {
          parentPort.postMessage({ error: { type: e instanceof m.PdfError ? 'PdfError' : e?.constructor?.name, message: String(e?.message) } });
        }
      });`, { eval: true, workerData: { url: READ_URL, bytes } });
    const t = setTimeout(() => { w.terminate(); resolve({ hang: true }); }, ms);
    w.once('message', r => { clearTimeout(t); w.terminate(); resolve(r); });
    w.once('error', e => { clearTimeout(t); resolve({ error: { type: 'WorkerError', message: String(e) } }); });
  });
}

/**
 * Большой PDF как у reportlab: на каждой странице текст-метка и одна JPEG-картинка
 * (ASCII85+DCT или чистый DCT). jpegs = [{ bytes: Uint8Array, w, h }].
 */
export function imagePdf(jpegs, { a85 = true, gray = false } = {}) {
  const extraObjs = {};
  const pages = jpegs.map((j, i) => {
    const num = 100 + i;
    const data = a85 ? Buffer.from(ascii85Encode(j.bytes), 'latin1') : Buffer.from(j.bytes);
    extraObjs[num] = {
      dict: `/Type /XObject /Subtype /Image /Width ${j.w} /Height ${j.h} /ColorSpace /${gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter ${a85 ? '[/ASCII85Decode /DCTDecode]' : '/DCTDecode'}`,
      data,
    };
    return {
      box: [0, 0, 595, 842], xobjects: { Im0: num },
      content: `q 500 0 0 600 40 150 cm /Im0 Do Q BT /F1 24 Tf 50 780 Td (BIG-P${i + 1}) Tj ET`,
    };
  });
  return handPdf(pages, { extraObjs });
}

import crypto from 'node:crypto';
const hash = u => crypto.createHash('sha1').update(u).digest('hex').slice(0, 12);
const nm = v => (Array.isArray(v) ? v.map(x => x?.n).join('+') : v?.n ?? '');

/** Сведения о картинке Im0 каждой страницы: фильтр, размеры, цветовое пространство, хэш данных, маска. */
export async function imageInfo(doc) {
  const out = [];
  for (const p of doc.pageRefs) {
    const res = await doc.get(p.dict.get('Resources') ?? p.inherited.Resources);
    const xo = isDict(res) ? await doc.get(res.get('XObject')) : null;
    const im = isDict(xo) ? await doc.get(xo.get('Im0')) : null;
    if (!(im instanceof Stream)) { out.push(null); continue; } // на странице нет картинки Im0
    const cs = await doc.get(im.dict.get('ColorSpace'));
    const sm = await doc.get(im.dict.get('SMask'));
    out.push({
      filter: nm(await doc.get(im.dict.get('Filter'))),
      w: im.dict.get('Width'), h: im.dict.get('Height'),
      cs: Array.isArray(cs) ? nm(cs[0]) : nm(cs),
      bpc: im.dict.get('BitsPerComponent'),
      size: im.raw.length, hash: hash(im.raw),
      hasDecode: im.dict.has('Decode'), hasMask: im.dict.has('Mask'), imageMask: im.dict.get('ImageMask') === true,
      smask: sm instanceof Stream ? { filter: nm(await doc.get(sm.dict.get('Filter'))), w: sm.dict.get('Width'), h: sm.dict.get('Height'), hash: hash(sm.raw) } : null,
      raw: im.raw,
    });
  }
  return out;
}

/** Файл для setInputFiles из тестового PDF (или своих байтов). */
export const pdfInput = (name, bytes = fx(name.replace(/\.pdf$/, '')), mimeType = 'application/pdf') => ({ name: name.endsWith('.pdf') ? name : name + '.pdf', mimeType, buffer: Buffer.from(bytes) });

/**
 * PDF 1.5 со сжатой таблицей и потоком объектов (страница и дерево страниц лежат в потоке).
 * variant: 'ok' | 'crlf' (в данные потока попал перевод строки) | 'adler' (неверная контрольная сумма) |
 * 'raw' (без заголовка zlib).
 */
export function objStmPdf(variant = 'ok', mark = 'OBJ-P1', { info = false } = {}) {
  const members = [
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>'],
  ];
  let head = '', body = '';
  for (const [n, v] of members) { head += `${n} ${body.length} `; body += v + '\n'; }
  const plain = Buffer.from(head + body, 'latin1');
  let data;
  if (variant === 'raw') data = zlib.deflateRawSync(plain);
  else {
    data = zlib.deflateSync(plain);
    if (variant === 'adler') data = Buffer.concat([data.subarray(0, -4), Buffer.alloc(4)]);
    if (variant === 'crlf') data = Buffer.concat([data, Buffer.from('\r\n')]);
  }
  const content = Buffer.from(`BT /F1 20 Tf 20 100 Td (${mark}) Tj ET`);
  const parts = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const off = {};
  let pos = parts[0].length;
  const add = (n, buf) => { off[n] = pos; parts.push(buf); pos += buf.length; };
  add(1, Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'));
  if (info) add(7, Buffer.from('7 0 obj\n<< /Title (INFO-OLD) >>\nendobj\n'));
  add(4, Buffer.concat([Buffer.from(`4 0 obj\n<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream\nendobj\n')]));
  add(5, Buffer.concat([Buffer.from(`5 0 obj\n<< /Type /ObjStm /N 2 /First ${head.length} /Filter /FlateDecode /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream\nendobj\n')]));
  const rows = [];
  const row = (t, a, b) => rows.push(Buffer.from([t, a >> 8, a & 255, b]));
  row(0, 0, 255); row(1, off[1], 0); row(2, 5, 0); row(2, 5, 1); row(1, off[4], 0); row(1, off[5], 0);
  off[6] = pos; row(1, pos, 0); if (info) row(1, off[7], 0);
  const xs = zlib.deflateSync(Buffer.concat(rows));
  add(6, Buffer.concat([Buffer.from(`6 0 obj\n<< /Type /XRef /Size ${info ? 8 : 7} /W [1 2 1] /Root 1 0 R${info ? ' /Info 7 0 R' : ''} /Filter /FlateDecode /Length ${xs.length} >>\nstream\n`), xs, Buffer.from('\nendstream\nendobj\n')]));
  parts.push(Buffer.from(`startxref\n${off[6]}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

/** Меняет смещения в классической таблице xref: fn(номер, смещение) → новое смещение. Длина файла не меняется. */
export function patchXref(bytes, fn) {
  const s = latin1(bytes);
  const x = s.lastIndexOf('xref\n0 ');
  const m = /xref\n0 (\d+)\n/.exec(s.slice(x));
  const n = +m[1];
  const out = Buffer.from(bytes);
  let p = x + m[0].length;
  for (let i = 0; i < n; i++, p += 20) {
    if (s[p + 17] !== 'n') continue;
    out.write(String(fn(i, +s.slice(p, p + 10))).padStart(10, '0'), p, 'latin1');
  }
  return new Uint8Array(out);
}

/** Смещение объекта «N 0 obj» в файле. */
export const offsetOf = (bytes, num) => latin1(bytes).indexOf(`\n${num} 0 obj`) + 1;

import { Writer } from '../app/pdftools.js';
import { Name as NameCls, name as mkName } from '../app/pdfread.js';
/**
 * Плотный PDF без /Info: n страниц, на каждой одна и та же JPEG-картинка (DCT). Пересборка приложением
 * (добавляет /Info) получается чуть больше исходного.
 */
export async function tightImagePdf(jpeg, w, h, n = 3) {
  const wr = new Writer();
  const pagesNum = wr.alloc();
  const kids = [];
  for (let i = 0; i < n; i++) {
    const img = wr.add(new Stream(new Map([['Type', mkName('XObject')], ['Subtype', mkName('Image')], ['Width', w], ['Height', h],
      ['ColorSpace', mkName('DeviceRGB')], ['BitsPerComponent', 8], ['Filter', mkName('DCTDecode')]]), jpeg));
    const content = wr.add(new Stream(new Map(), Buffer.from('q 400 0 0 400 0 0 cm /Im0 Do Q')));
    kids.push(wr.add(new Map([['Type', mkName('Page')], ['Parent', new Ref(pagesNum, 0)], ['MediaBox', [0, 0, 400, 400]],
      ['Resources', new Map([['XObject', new Map([['Im0', img]])]])], ['Contents', content]])));
  }
  wr.set(pagesNum, new Map([['Type', mkName('Pages')], ['Kids', kids], ['Count', n]]));
  const root = wr.add(new Map([['Type', mkName('Catalog')], ['Pages', new Ref(pagesNum, 0)]]));
  return new Uint8Array(await wr.toBlob(root, null).arrayBuffer());
}
