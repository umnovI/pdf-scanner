// Объединение и сжатие PDF целиком на телефоне.
// Страницы копируются вместе со всем, на что ссылаются (шрифты, картинки,
// аннотации); остальное содержимое исходного файла (закладки, формы, структура
// для чтения с экрана) в результат не попадает.

import { PdfDoc, PdfError, Name, Ref, Str, Stream, decodeStream, isDict, isName, name } from './pdfread.js';

export { PdfDoc, PdfError };

// ---------- Запись ----------

const enc = new TextEncoder();
const bytesOf = s => {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xFF;
  return u;
};

function fmtNum(v) {
  if (Number.isInteger(v)) return String(v);
  if (!Number.isFinite(v) || Math.abs(v) < 1e-6) return '0';
  return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

const NAME_OK = /^[!-~]$/;
function fmtName(n) {
  let s = '/';
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    s += NAME_OK.test(ch) && !'()<>[]{}/%#'.includes(ch) ? ch : '#' + c.toString(16).padStart(2, '0');
  }
  return s;
}

function serialize(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return String(v);
  if (v instanceof Name) return fmtName(v.n);
  if (v instanceof Ref) return `${v.num} 0 R`;
  if (v instanceof Str) {
    let h = '<';
    for (const b of v.bytes) h += b.toString(16).padStart(2, '0');
    return h + '>';
  }
  if (Array.isArray(v)) return '[' + v.map(serialize).join(' ') + ']';
  if (isDict(v)) {
    let s = '<<';
    for (const [k, x] of v) s += fmtName(k) + ' ' + serialize(x) + ' ';
    return s + '>>';
  }
  throw new Error('Неизвестное значение PDF');
}

/** Новый PDF: объекты по номерам, запись в Blob. */
export class Writer {
  constructor() { this.objs = [null]; }
  alloc() { this.objs.push(undefined); return this.objs.length - 1; }
  set(n, v) { this.objs[n] = v; }
  add(v) { const n = this.alloc(); this.set(n, v); return new Ref(n, 0); }

  /** root — ссылка на каталог; info — словарь сведений о документе. */
  toBlob(root, info) {
    const chunks = [];
    let offset = 0;
    const push = u => { chunks.push(u); offset += u.length; };
    const str = s => push(bytesOf(s));
    str('%PDF-1.7\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));
    const infoRef = info ? this.add(info) : null;
    const offsets = new Array(this.objs.length).fill(0);
    for (let n = 1; n < this.objs.length; n++) {
      let v = this.objs[n];
      if (v === undefined) v = null;
      offsets[n] = offset;
      if (v instanceof Stream) {
        const d = new Map(v.dict);
        d.set('Length', v.raw.length);
        str(`${n} 0 obj\n${serialize(d)}\nstream\n`);
        push(v.raw);
        str('\nendstream\nendobj\n');
      } else {
        str(`${n} 0 obj\n${serialize(v)}\nendobj\n`);
      }
    }
    const xref = offset;
    let t = `xref\n0 ${this.objs.length}\n0000000000 65535 f \n`;
    for (let n = 1; n < this.objs.length; n++) t += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    t += `trailer\n<< /Size ${this.objs.length} /Root ${root.num} 0 R${infoRef ? ` /Info ${infoRef.num} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
    str(t);
    return new Blob(chunks, { type: 'application/pdf' });
  }
}

// Строка PDF в UTF-16 (для названия документа).
export function textStr(s) {
  const u = [0xFE, 0xFF];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c > 0xFFFF) {
      const v = c - 0x10000;
      const hi = 0xD800 + (v >> 10), lo = 0xDC00 + (v & 0x3FF);
      u.push(hi >> 8, hi & 0xFF, lo >> 8, lo & 0xFF);
    } else u.push(c >> 8, c & 0xFF);
  }
  return new Str(Uint8Array.from(u));
}

// Ключи страницы, которые не переносятся: дерево страниц строится заново,
// статьи (/B) и структура документа остаются в исходном файле.
const PAGE_DROP = new Set(['Parent', 'B', 'StructParents', 'PieceInfo']);
const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];

/**
 * Копирует страницы документов в writer. Ссылки на страницы (например, из
 * ссылок-аннотаций) указывают на скопированные страницы.
 * @returns {Promise<Ref[]>} новые страницы по порядку
 */
async function copyPages(writer, docs, parentRef, onProgress) {
  const pages = [];
  const map = new Map(); // `${номер источника}:${num}` → новый номер
  const queue = [];
  // Ключ — номер источника по порядку, а не документ: один и тот же документ,
  // переданный дважды, копируется дважды независимо.
  const key = (src, num) => `${src}:${num}`;
  const refFor = (src, doc, ref) => {
    const k = key(src, ref.num);
    let n = map.get(k);
    if (n === undefined) { n = writer.alloc(); map.set(k, n); queue.push([src, doc, ref, n]); }
    return new Ref(n, 0);
  };
  // Номера страниц выделяются заранее — ссылки между страницами сохраняются.
  docs.forEach((doc, src) => {
    for (const p of doc.pageRefs) {
      const n = writer.alloc();
      map.set(key(src, p.ref.num), n);
      pages.push({ src, doc, page: p, n });
    }
  });
  const remap = (src, doc, v, depth = 0) => {
    if (depth > 100) return null;
    if (v instanceof Ref) return refFor(src, doc, v);
    if (Array.isArray(v)) return v.map(x => remap(src, doc, x, depth + 1));
    if (isDict(v)) {
      const d = new Map();
      for (const [k, x] of v) d.set(k, remap(src, doc, x, depth + 1));
      return d;
    }
    return v;
  };
  const drain = async () => {
    while (queue.length) {
      const [src, doc, ref, n] = queue.shift();
      const v = await doc.get(ref);
      if (v instanceof Stream) writer.set(n, new Stream(remap(src, doc, v.dict), v.raw));
      else if (isDict(v) && isName(v.get('Type'), 'Page')) writer.set(n, null); // чужая страница вне списка
      else writer.set(n, remap(src, doc, v));
    }
  };
  for (let i = 0; i < pages.length; i++) {
    const { src, doc, page, n } = pages[i];
    const d = new Map();
    for (const [k, x] of page.dict) if (!PAGE_DROP.has(k)) d.set(k, x);
    for (const k of INHERITED) if (!d.has(k) && page.inherited[k] !== undefined) d.set(k, page.inherited[k]);
    if (!d.has('MediaBox')) d.set('MediaBox', [0, 0, 595.28, 841.89]);
    const out = remap(src, doc, d);
    out.set('Type', name('Page'));
    out.set('Parent', parentRef);
    writer.set(n, out);
    await drain();
    onProgress?.(i + 1, pages.length);
  }
  return pages.map(p => new Ref(p.n, 0));
}

function finish(writer, pagesRef, kids, title) {
  writer.set(pagesRef.num, new Map([['Type', name('Pages')], ['Kids', kids], ['Count', kids.length]]));
  const root = writer.add(new Map([['Type', name('Catalog')], ['Pages', pagesRef]]));
  const info = new Map([['Producer', textStr('Сканер PDF')]]);
  if (title) info.set('Title', textStr(title));
  return writer.toBlob(root, info);
}

/**
 * Объединяет PDF по порядку.
 * @param {Uint8Array[]|PdfDoc[]} sources
 * @returns {Promise<{ blob: Blob, pages: number }>}
 */
export async function mergePdfs(sources, { title, onProgress } = {}) {
  const docs = [];
  for (const s of sources) docs.push(s instanceof PdfDoc ? s : await PdfDoc.load(s));
  const w = new Writer();
  const pagesRef = new Ref(w.alloc(), 0);
  const kids = await copyPages(w, docs, pagesRef, onProgress);
  return { blob: finish(w, pagesRef, kids, title), pages: kids.length };
}

// ---------- Сжатие ----------

// Уровни сжатия картинок: от почти без потерь к сильному.
export const LEVELS = [
  { maxSide: 3000, q: 0.85 },
  { maxSide: 2500, q: 0.8 },
  { maxSide: 2200, q: 0.75 },
  { maxSide: 2000, q: 0.7 },
  { maxSide: 1800, q: 0.65 },
  { maxSide: 1600, q: 0.6 },
  { maxSide: 1400, q: 0.55 },
  { maxSide: 1250, q: 0.5 },
  { maxSide: 1100, q: 0.45 },
  { maxSide: 1000, q: 0.4 },
  { maxSide: 900, q: 0.35 },
  { maxSide: 800, q: 0.3 },
  { maxSide: 650, q: 0.25 },
  { maxSide: 500, q: 0.2 },
];

const filterNames = dict => {
  const f = dict.get('Filter');
  return (Array.isArray(f) ? f : f ? [f] : []).map(x => (x instanceof Name ? x.n : ''));
};

// Число цветовых каналов картинки, если её можно перекодировать; иначе 0.
function channels(writer, cs) {
  if (cs instanceof Ref) cs = writer.objs[cs.num];
  if (isName(cs, 'DeviceRGB') || isName(cs, 'RGB')) return 3;
  if (isName(cs, 'DeviceGray') || isName(cs, 'G')) return 1;
  if (Array.isArray(cs) && isName(cs[0], 'ICCBased')) {
    let s = cs[1];
    if (s instanceof Ref) s = writer.objs[s.num];
    const n = s instanceof Stream ? s.dict.get('N') : 0;
    return n === 1 || n === 3 ? n : 0;
  }
  return 0;
}

// Картинки, которые можно перекодировать в JPEG: { n, kind, ch }.
function findImages(writer) {
  const masks = new Set();
  for (const v of writer.objs) {
    const d = v instanceof Stream ? v.dict : isDict(v) ? v : null;
    if (!d) continue;
    for (const k of ['SMask', 'Mask']) if (d.get(k) instanceof Ref) masks.add(d.get(k).num);
  }
  const out = [];
  writer.objs.forEach((v, n) => {
    if (!(v instanceof Stream) || masks.has(n)) return;
    const d = v.dict;
    if (!isName(d.get('Subtype'), 'Image') || d.get('ImageMask') === true || d.has('Decode')) return;
    if (Array.isArray(d.get('Mask'))) return; // маска по цвету: после JPEG цвета «поплывут»
    if (v.raw.length < 16 * 1024) return; // мелочь не стоит потерь качества
    const w = d.get('Width'), h = d.get('Height');
    if (typeof w !== 'number' || typeof h !== 'number' || w < 32 || h < 32 || w * h > 40e6) return;
    const ch = channels(writer, d.get('ColorSpace'));
    if (!ch) return;
    const f = filterNames(d);
    if (f.length === 1 && (f[0] === 'DCTDecode' || f[0] === 'DCT')) out.push({ n, kind: 'jpeg', ch });
    else if (f.length === 1 && (f[0] === 'FlateDecode' || f[0] === 'Fl') && d.get('BitsPerComponent') === 8) out.push({ n, kind: 'flate', ch });
  });
  return out;
}

// JPEG без блоков APP1 с EXIF (остальное — как было).
export function stripExif(b) {
  if (b[0] !== 0xFF || b[1] !== 0xD8) return b;
  const parts = [b.subarray(0, 2)];
  let p = 2, keep = 2;
  while (p + 4 <= b.length && b[p] === 0xFF) {
    const m = b[p + 1];
    if (m === 0xDA || m === 0xD9) break; // начались данные изображения
    const len = (b[p + 2] << 8) | b[p + 3];
    const exif = m === 0xE1 && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66; // «Exif»
    if (exif) { parts.push(b.subarray(keep, p)); keep = p + 2 + len; }
    p += 2 + len;
  }
  if (parts.length === 1) return b;
  parts.push(b.subarray(keep));
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

async function decodeImage(writer, stream, kind, ch) {
  if (kind === 'jpeg') {
    // PDF не учитывает поворот из EXIF, а браузер учитывает даже с
    // imageOrientation: 'none' — поэтому EXIF убираем из копии данных.
    return createImageBitmap(new Blob([stripExif(stream.raw)], { type: 'image/jpeg' }), { imageOrientation: 'none' });
  }
  const d = stream.dict;
  const w = d.get('Width'), h = d.get('Height');
  const r = await decodeStream(stream, new Set(), v => (v instanceof Ref ? writer.objs[v.num] : v));
  if (r.filters.length) throw new Error('не распаковать');
  const data = r.data;
  if (data.length < w * h * ch) throw new Error('мало данных');
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += ch) {
    const r = data[j], g = ch === 3 ? data[j + 1] : r, b = ch === 3 ? data[j + 2] : r;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  return createImageBitmap(new ImageData(rgba, w, h));
}

async function encodeJpeg(bitmap, { maxSide, q }) {
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k)), h = Math.max(1, Math.round(bitmap.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
  c.width = c.height = 0;
  return { raw: new Uint8Array(await blob.arrayBuffer()), w, h };
}

const ASCII = new Set(['ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx']);
const NOT_ASCII = { has: f => !ASCII.has(f) };

const deflate = async data => {
  const res = new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate')));
  return new Uint8Array(await res.arrayBuffer());
};

/**
 * Без потерь: снимает текстовые обёртки ASCII85/ASCIIHex (+25–100 % к размеру)
 * и сжимает потоки, которые хранятся без сжатия (например, содержимое страниц).
 */
async function normalizeStreams(writer) {
  const resolve = v => (v instanceof Ref ? writer.objs[v.num] : v);
  for (let n = 1; n < writer.objs.length; n++) {
    const v = writer.objs[n];
    if (!(v instanceof Stream) || v.dict.has('F')) continue;
    let { dict, raw } = v;
    const first = [].concat(resolve(dict.get('Filter')) ?? [])[0];
    if (first instanceof Name && ASCII.has(first.n)) {
      try {
        const r = await decodeStream(v, NOT_ASCII, resolve);
        dict = new Map(dict);
        raw = r.data;
        if (r.filters.length) {
          dict.set('Filter', r.filters.length === 1 ? r.filters[0] : r.filters);
          if (r.parms.some(x => x != null)) dict.set('DecodeParms', r.parms.length === 1 ? r.parms[0] : r.parms);
          else dict.delete('DecodeParms');
        } else {
          dict.delete('Filter');
          dict.delete('DecodeParms');
        }
      } catch { continue; } // повреждённые данные — оставляем как есть
    }
    if (!dict.has('Filter') && !dict.has('DecodeParms') && raw.length >= 256) {
      const z = await deflate(raw);
      if (z.length < raw.length) {
        dict = new Map(dict);
        dict.set('Filter', name('FlateDecode'));
        raw = z;
      }
    }
    if (raw !== v.raw) writer.set(n, new Stream(dict, raw));
  }
}

/**
 * Сжимает PDF так, чтобы он стал не больше target байт (если это возможно).
 * Сначала без потерь (пересборка файла), потом всё сильнее сжимает картинки —
 * подбирает наилучшее качество, при котором файл укладывается в размер.
 * @returns {Promise<{ blob: Blob, fits: boolean, level: number, original: number, pages: number, images: number }>}
 *   images — сколько картинок можно сжимать (0 — сжимать нечего)
 *   level: -1 — без потерь; fits=false — уложиться не удалось, blob — самый маленький вариант
 */
export async function compressPdf(bytes, target, { title, onProgress } = {}) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const doc = await PdfDoc.load(bytes);
  const w = new Writer();
  const pagesRef = new Ref(w.alloc(), 0);
  onProgress?.({ stage: 'read' });
  const kids = await copyPages(w, [doc], pagesRef);
  w.set(pagesRef.num, new Map([['Type', name('Pages')], ['Kids', kids], ['Count', kids.length]]));
  await normalizeStreams(w);
  const root = w.add(new Map([['Type', name('Catalog')], ['Pages', pagesRef]]));
  const info = new Map([['Producer', textStr('Сканер PDF')]]);
  if (title) info.set('Title', textStr(title));
  const build = () => {
    const copy = new Writer();
    copy.objs = w.objs.slice();
    return copy.toBlob(root, info);
  };
  let imageCount = 0;
  const result = (blob, fits, level) => ({ blob, fits, level, original: bytes.length, pages: kids.length, images: imageCount });

  const images = findImages(w);
  imageCount = images.length;
  const lossless = build();
  if (lossless.size <= target) return result(lossless, true, -1);
  if (!images.length) return result(lossless, false, -1);
  const originals = new Map(images.map(im => [im.n, w.objs[im.n]]));

  // Перекодирует все картинки на уровне i; картинка остаётся прежней, если новая больше.
  const tries = new Map();
  const tryLevel = async i => {
    if (tries.has(i)) return tries.get(i);
    for (let k = 0; k < images.length; k++) {
      const { n, kind, ch } = images[k];
      onProgress?.({ stage: 'images', level: i, image: k + 1, images: images.length });
      const src = originals.get(n);
      let bitmap = null;
      try {
        bitmap = await decodeImage(w, src, kind, ch);
        const { raw, w: iw, h: ih } = await encodeJpeg(bitmap, LEVELS[i]);
        if (raw.length < src.raw.length) {
          const d = new Map(src.dict);
          d.set('Filter', name('DCTDecode'));
          d.delete('DecodeParms');
          d.set('Width', iw); d.set('Height', ih);
          d.set('BitsPerComponent', 8);
          if (ch === 1 || !(Array.isArray(d.get('ColorSpace')) || d.get('ColorSpace') instanceof Ref)) d.set('ColorSpace', name('DeviceRGB'));
          w.set(n, new Stream(d, raw));
        } else w.set(n, src);
      } catch {
        w.set(n, src); // не получилось — оставляем как было
      } finally {
        bitmap?.close?.();
      }
    }
    const blob = build();
    tries.set(i, blob);
    return blob;
  };

  // Наилучшее качество, при котором файл помещается: двоичный поиск по уровням.
  const lastIdx = LEVELS.length - 1;
  const smallest = await tryLevel(lastIdx);
  if (smallest.size > target) return result(smallest.size < lossless.size ? smallest : lossless, false, lastIdx);
  let lo = 0, hi = lastIdx; // hi всегда помещается
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((await tryLevel(mid)).size <= target) hi = mid; else lo = mid + 1;
  }
  return result(tries.get(hi), true, hi);
}
