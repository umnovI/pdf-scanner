// Чтение чужих PDF без библиотек: разбор объектов, таблицы ссылок (обычной
// и сжатой — PDF 1.5+), потоков объектов, дерева страниц. Нужен для
// объединения и сжатия PDF. Зашифрованные файлы не открываются.

/** Ошибка с понятным пользователю текстом. */
export class PdfError extends Error {}

export class Name {
  constructor(n) { this.n = n; }
}
const names = new Map();
/** Имя PDF (/Type и т. п.); одинаковые имена — один и тот же объект. */
export const name = n => {
  let v = names.get(n);
  if (!v) { v = new Name(n); names.set(n, v); }
  return v;
};
export class Ref {
  constructor(num, gen) { this.num = num; this.gen = gen; }
}
export class Str {
  constructor(bytes) { this.bytes = bytes; }
}
export class Stream {
  constructor(dict, raw) { this.dict = dict; this.raw = raw; }
}
/** Словарь PDF — Map с ключами-строками (имя без «/»). */
export const isDict = v => v instanceof Map;
export const isName = (v, n) => v instanceof Name && (n === undefined || v.n === n);

// ---------- Лексер ----------

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const isRegular = c => !WS[c] && !DELIM[c];

export const latin1 = (b, s = 0, e = b.length) => {
  let out = '';
  for (let i = s; i < e; i += 8192) out += String.fromCharCode.apply(null, b.subarray(i, Math.min(e, i + 8192)));
  return out;
};

class Lexer {
  constructor(bytes, pos = 0) { this.b = bytes; this.pos = pos; }

  skipWs() {
    const b = this.b;
    for (;;) {
      while (this.pos < b.length && WS[b[this.pos]]) this.pos++;
      if (b[this.pos] !== 0x25) return; // %
      while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
    }
  }

  // Следующее слово (число, ключевое слово) без разбора.
  word() {
    this.skipWs();
    const s = this.pos;
    while (this.pos < this.b.length && isRegular(this.b[this.pos])) this.pos++;
    return latin1(this.b, s, this.pos);
  }

  peekWord() {
    const p = this.pos;
    const w = this.word();
    this.pos = p;
    return w;
  }

  // Значение; ссылки «1 0 R» распознаются здесь же.
  value(depth = 0) {
    if (depth > 200) throw new PdfError('Слишком глубокая вложенность в PDF');
    this.skipWs();
    const b = this.b;
    const c = b[this.pos];
    if (c === undefined) throw new PdfError('Неожиданный конец PDF');
    if (c === 0x2F) return this.name();                                  // /
    if (c === 0x28) return this.literal();                               // (
    if (c === 0x5B) {                                                    // [
      this.pos++;
      const arr = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= b.length) throw new PdfError('Неожиданный конец PDF');
        if (b[this.pos] === 0x5D) { this.pos++; return arr; }
        arr.push(this.value(depth + 1));
      }
    }
    if (c === 0x3C) {                                                    // <
      if (b[this.pos + 1] === 0x3C) {
        this.pos += 2;
        const d = new Map();
        for (;;) {
          this.skipWs();
          if (this.pos >= b.length) throw new PdfError('Неожиданный конец PDF');
          if (b[this.pos] === 0x3E && b[this.pos + 1] === 0x3E) { this.pos += 2; return d; }
          const k = this.value(depth + 1);
          if (!(k instanceof Name)) throw new PdfError('Повреждённый словарь в PDF');
          d.set(k.n, this.value(depth + 1));
        }
      }
      return this.hex();
    }
    if (c === 0x5D || c === 0x3E || c === 0x29 || c === 0x7B || c === 0x7D) {
      this.pos++;
      throw new PdfError('Повреждённый PDF');
    }
    const w = this.word();
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) throw new PdfError('Повреждённый PDF');
    const n = parseFloat(w);
    // «num gen R» — ссылка
    if (/^\d+$/.test(w)) {
      const p = this.pos;
      const g = this.word();
      if (/^\d+$/.test(g) && this.word() === 'R') return new Ref(n, +g);
      this.pos = p;
    }
    return n;
  }

  name() {
    const b = this.b;
    this.pos++;
    let s = '';
    while (this.pos < b.length && isRegular(b[this.pos])) {
      const c = b[this.pos++];
      if (c === 0x23 && this.pos + 1 < b.length) { // #xx
        const h = parseInt(String.fromCharCode(b[this.pos], b[this.pos + 1]), 16);
        if (!Number.isNaN(h)) { s += String.fromCharCode(h); this.pos += 2; continue; }
      }
      s += String.fromCharCode(c);
    }
    return name(s);
  }

  literal() {
    const b = this.b;
    this.pos++;
    const out = [];
    let depth = 1;
    while (this.pos < b.length) {
      let c = b[this.pos++];
      if (c === 0x5C) { // \
        c = b[this.pos++];
        const esc = { 0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 }[c];
        if (esc !== undefined) out.push(esc);
        else if (c >= 0x30 && c <= 0x37) {
          let v = c - 0x30;
          for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) v = v * 8 + b[this.pos++] - 0x30;
          out.push(v & 0xFF);
        } else if (c === 13) { if (b[this.pos] === 10) this.pos++; } // перенос строки
        else if (c !== 10) out.push(c);
        continue;
      }
      if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) return new Str(Uint8Array.from(out));
      out.push(c);
    }
    throw new PdfError('Неожиданный конец PDF');
  }

  hex() {
    const b = this.b;
    this.pos++;
    const out = [];
    let hi = -1;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x3E) {
        if (hi >= 0) out.push(hi << 4);
        return new Str(Uint8Array.from(out));
      }
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v < 0) continue;
      if (hi < 0) hi = v; else { out.push((hi << 4) | v); hi = -1; }
    }
    throw new PdfError('Неожиданный конец PDF');
  }
}

// ---------- Фильтры ----------

async function inflateWith(fmt, d) {
  const ds = new DecompressionStream(fmt);
  const res = new Response(new Blob([d]).stream().pipeThrough(ds));
  return new Uint8Array(await res.arrayBuffer());
}

// Распаковка «сколько получится»: данные подаются частями, и всё, что успело
// распаковаться до ошибки (мусор в конце, обрезанный поток), сохраняется.
async function inflatePartial(fmt, d) {
  const ds = new DecompressionStream(fmt);
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
    } catch { /* остаток не распаковался */ }
  })();
  try {
    // Частями: распакованное успевает уйти к читателю до ошибки в хвосте.
    for (let i = 0; i < d.length; i += 65536) await writer.write(d.subarray(i, Math.min(d.length, i + 65536)));
    await writer.close();
  } catch { /* ошибка в данных — берём прочитанное */ }
  await reading;
  if (!total) throw new Error('пусто');
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const trimEnd = d => {
  let e = d.length;
  while (e > 0 && WS[d[e - 1]]) e--;
  return d.subarray(0, e);
};

async function inflate(data) {
  const t = trimEnd(data);
  const attempts = [
    ['deflate', data],
    ['deflate', t],                          // в /Length попал перевод строки
    ['deflate-raw', t.subarray(2, -4)],     // неверная контрольная сумма
    ['deflate-raw', t.subarray(2)],         // контрольной суммы нет
    ['deflate-raw', t],                     // нет заголовка zlib
  ];
  for (const [fmt, d] of attempts) {
    if (d.length < 1) continue;
    try { return await inflateWith(fmt, d); } catch { /* следующий способ */ }
  }
  for (const [fmt, d] of [['deflate', data], ['deflate-raw', data.subarray(2)], ['deflate-raw', data]]) {
    try { return await inflatePartial(fmt, d); } catch { /* следующий способ */ }
  }
  throw new PdfError('Не удалось распаковать данные PDF');
}

// Предиктор PNG (/Predictor 10–15) из /DecodeParms.
export function unpredict(data, parms) {
  const pred = num(parms?.get('Predictor'), 1);
  if (pred < 10) {
    if (pred === 1) return data;
    throw new PdfError('Неподдерживаемый способ сжатия в PDF');
  }
  const colors = num(parms.get('Colors'), 1);
  const bpc = num(parms.get('BitsPerComponent'), 8);
  const cols = num(parms.get('Columns'), 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const row = Math.ceil((colors * bpc * cols) / 8);
  const rows = Math.floor(data.length / (row + 1));
  const out = new Uint8Array(rows * row);
  let prev = new Uint8Array(row);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (row + 1)];
    const src = data.subarray(r * (row + 1) + 1, (r + 1) * (row + 1));
    const cur = out.subarray(r * row, (r + 1) * row);
    for (let i = 0; i < row; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (type === 1) v += a;
      else if (type === 2) v += up;
      else if (type === 3) v += (a + up) >> 1;
      else if (type === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v;
    }
    prev = cur;
  }
  return out;
}

export function ascii85(b) {
  const out = [];
  let tuple = 0, n = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x7E) break; // ~>
    if (WS[c]) continue;
    if (c === 0x7A && n === 0) { out.push(0, 0, 0, 0); continue; } // z
    if (c < 33 || c > 117) throw new PdfError('Повреждённые данные в PDF');
    tuple = tuple * 85 + (c - 33);
    if (++n === 5) {
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0; n = 0;
    }
  }
  if (n > 1) {
    for (let k = n; k < 5; k++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

export function asciiHex(b) {
  const out = [];
  let hi = -1;
  for (const c of b) {
    if (c === 0x3E) break;
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v; else { out.push((hi << 4) | v); hi = -1; }
  }
  if (hi >= 0) out.push(hi << 4);
  return Uint8Array.from(out);
}

const DECODABLE = new Set(['FlateDecode', 'Fl', 'ASCII85Decode', 'A85', 'ASCIIHexDecode', 'AHx']);

/**
 * Снимает фильтры потока по порядку, пока не встретится фильтр из stop (или
 * неподдерживаемый). resolve — получение значения по ссылке.
 * @returns {Promise<{ data: Uint8Array, filters: Name[], parms: any[] }>} данные и оставшиеся фильтры
 */
export async function decodeStream(stream, stop, resolve) {
  const filters = asArray(await resolve(stream.dict.get('Filter')));
  const parms = asArray(await resolve(stream.dict.get('DecodeParms')));
  let data = stream.raw;
  let i = 0;
  for (; i < filters.length; i++) {
    const f = filters[i]?.n;
    if (stop.has(f) || !DECODABLE.has(f)) break;
    if (f === 'FlateDecode' || f === 'Fl') {
      data = await inflate(data);
      const p = await resolve(parms[i]);
      if (isDict(p)) data = unpredict(data, p);
    } else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
    else data = asciiHex(data);
  }
  return { data, filters: filters.slice(i), parms: parms.slice(i) };
}

const num = (v, def) => (typeof v === 'number' ? v : def);
const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------- Документ ----------

let docSeq = 0;

export class PdfDoc {
  constructor(bytes) {
    this.id = ++docSeq;
    this.bytes = bytes;
    this.xref = new Map(); // num → { type: 1, offset } | { type: 2, stm, idx }
    this.cache = new Map();
    this.objStms = new Map();
    this.trailer = new Map();
  }

  /** Открывает PDF; бросает PdfError с понятным текстом. */
  static async load(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const head = latin1(bytes, 0, Math.min(1024, bytes.length));
    const start = head.indexOf('%PDF-');
    if (start < 0) throw new PdfError('Это не PDF-файл');
    const body = start ? bytes.subarray(start) : bytes;
    let doc = new PdfDoc(body);
    let healthy = false;
    try {
      await doc.readXrefChain();
      if (!isDict(await doc.get(doc.trailer.get('Root')))) throw new Error('нет каталога');
      doc.pageRefs = await doc.collectPages();
      // Ссылка на страницу ведёт в пустоту или на чужой объект — таблица врёт.
      healthy = doc.pageRefs.length > 0 && !doc.missingPages;
    } catch (e) {
      if (e instanceof PdfError && /зашифр/.test(e.message)) throw e;
    }
    if (!healthy) {
      // Таблица ссылок повреждена или указывает не туда (страницы потерялись) —
      // восстанавливаем её, просмотрев файл целиком; берём вариант, где страниц больше.
      const rebuilt = new PdfDoc(body);
      try {
        await rebuilt.rebuildXref();
        rebuilt.pageRefs = await rebuilt.collectPages();
        if (!doc.pageRefs || rebuilt.pageRefs.length > doc.pageRefs.length) doc = rebuilt;
      } catch (e) {
        if (!doc.pageRefs?.length || (e instanceof PdfError && /зашифр/.test(e.message))) throw e;
      }
    }
    if (doc.trailer.has('Encrypt')) throw new PdfError('PDF защищён (зашифрован) — такие файлы не поддерживаются');
    if (!doc.pageRefs?.length) throw new PdfError('В PDF нет страниц');
    return doc;
  }

  async readXrefChain() {
    const tail = latin1(this.bytes, Math.max(0, this.bytes.length - 2048));
    const m = /startxref\s+(\d+)/g;
    let last = null, r;
    while ((r = m.exec(tail))) last = r;
    if (!last) throw new Error('нет startxref');
    const seen = new Set();
    let offset = +last[1];
    let first = true;
    while (offset != null && !seen.has(offset)) {
      seen.add(offset);
      const trailer = await this.readXrefAt(offset);
      if (first) { this.trailer = trailer; first = false; }
      if (trailer.has('Encrypt') && !this.trailer.has('Encrypt')) this.trailer.set('Encrypt', trailer.get('Encrypt'));
      // Гибридные файлы: дополнительная сжатая таблица.
      // Объекты из сжатой таблицы в обычной могут быть помечены свободными —
      // для этой ревизии сжатая таблица их дополняет.
      const stm = trailer.get('XRefStm');
      if (typeof stm === 'number' && !seen.has(stm)) { seen.add(stm); await this.readXrefAt(stm, this.freed); }
      offset = typeof trailer.get('Prev') === 'number' ? trailer.get('Prev') : null;
    }
    if (!this.trailer.has('Root')) throw new Error('нет Root');
  }

  // Читает одну таблицу (обычную или сжатую); более новые записи не перезаписываются.
  async readXrefAt(offset, overridable = null) {
    this.freed = new Set(); // номера, помеченные свободными в этой таблице
    if (offset < 0 || offset >= this.bytes.length) throw new Error('startxref за пределами файла');
    const lx = new Lexer(this.bytes, offset);
    if (lx.peekWord() === 'xref') {
      lx.word();
      for (;;) {
        const w = lx.peekWord();
        if (w === 'trailer') { lx.word(); break; }
        const sw = lx.word(), cw = lx.word();
        // Мусор вместо чисел — таблица повреждена (иначе цикл не сдвинется с места).
        if (!/^\d+$/.test(sw) || !/^\d+$/.test(cw)) throw new Error('повреждённая xref');
        const start = +sw, count = +cw;
        for (let i = 0; i < count; i++) {
          const ow = lx.word(), gw = lx.word(), kind = lx.word();
          if (!/^\d+$/.test(ow) || !/^\d+$/.test(gw) || (kind !== 'n' && kind !== 'f')) throw new Error('повреждённая xref');
          const off = +ow, gen = +gw;
          const n = start + i;
          if (this.xref.has(n)) continue;
          if (kind === 'n' && off > 0) this.xref.set(n, { type: 1, offset: off, gen });
          else { this.xref.set(n, { type: 0 }); this.freed.add(n); }
        }
      }
      const trailer = lx.value();
      if (!isDict(trailer)) throw new Error('повреждённый trailer');
      return trailer;
    }
    // Сжатая таблица: объект-поток /Type /XRef
    const obj = this.parseIndirectAt(offset);
    if (!(obj instanceof Stream) || !isName(obj.dict.get('Type'), 'XRef')) throw new Error('нет таблицы ссылок');
    const d = obj.dict;
    if (d.has('Encrypt')) throw new PdfError('PDF защищён (зашифрован) — такие файлы не поддерживаются');
    const data = await this.decode(obj);
    const w = asArray(d.get('W')).map(x => num(x, 0));
    const index = d.has('Index') ? asArray(d.get('Index')) : [0, num(d.get('Size'), 0)];
    const rowLen = w[0] + w[1] + w[2];
    if (!rowLen) throw new Error('повреждённая xref');
    let p = 0;
    const field = (len, def) => {
      if (!len) return def;
      let v = 0;
      for (let i = 0; i < len; i++) v = v * 256 + data[p++];
      return v;
    };
    for (let k = 0; k + 1 < index.length; k += 2) {
      const start = index[k], count = index[k + 1];
      for (let i = 0; i < count && p + rowLen <= data.length; i++) {
        const type = field(w[0], 1), f2 = field(w[1], 0), f3 = field(w[2], 0);
        const n = start + i;
        if (this.xref.has(n) && !(overridable?.has(n) && type !== 0)) continue;
        if (type === 1) this.xref.set(n, { type: 1, offset: f2, gen: f3 });
        else if (type === 2) this.xref.set(n, { type: 2, stm: f2, idx: f3 });
        else this.xref.set(n, { type: 0 });
      }
    }
    return d;
  }

  // Восстановление: ищем «N G obj» по всему файлу; последний экземпляр побеждает.
  async rebuildXref() {
    const text = latin1(this.bytes);
    const re = /(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(text))) {
      const offset = m.index + m[0].length - m[0].replace(/^[\s>\]]/, '').length;
      this.xref.set(+m[1], { type: 1, offset, gen: +m[2] });
    }
    // Потоки объектов тоже содержат объекты. Побеждает то определение, что
    // дальше в файле (более новая ревизия): для объекта из потока — место потока.
    const where = e => (e.type === 1 ? e.offset : e.pos);
    let xrefStmAt = -1;
    for (const [n, e] of [...this.xref]) {
      if (e.type !== 1) continue;
      let obj;
      try { obj = this.parseIndirectAt(e.offset); } catch { continue; }
      if (obj instanceof Stream && isName(obj.dict.get('Type'), 'ObjStm')) {
        try {
          const { offsets } = await this.loadObjStm(n, obj);
          offsets.forEach((num_, idx) => {
            const old = this.xref.get(num_);
            if (!old || where(old) < e.offset) this.xref.set(num_, { type: 2, stm: n, idx, pos: e.offset });
          });
        } catch { /* пропускаем повреждённый поток */ }
      }
      if (obj instanceof Stream && isName(obj.dict.get('Type'), 'XRef') && obj.dict.has('Root') && e.offset > xrefStmAt) {
        xrefStmAt = e.offset;
        this.trailer = new Map();
        for (const k of ['Root', 'Info', 'Encrypt']) if (obj.dict.has(k)) this.trailer.set(k, obj.dict.get(k));
      }
    }
    let t = text.lastIndexOf('trailer');
    while (t >= 0 && !this.trailer.has('Root')) {
      try {
        const tr = new Lexer(this.bytes, t + 7).value();
        if (isDict(tr)) for (const k of ['Root', 'Info', 'Encrypt']) if (tr.has(k)) this.trailer.set(k, tr.get(k));
      } catch { /* смотрим предыдущий */ }
      t = text.lastIndexOf('trailer', t - 1);
    }
    if (!this.trailer.has('Root')) {
      for (const n of this.xref.keys()) {
        const o = await this.get(new Ref(n, 0)).catch(() => null);
        if (isDict(o) && isName(o.get('Type'), 'Catalog')) { this.trailer.set('Root', new Ref(n, 0)); break; }
      }
    }
    if (this.trailer.has('Encrypt')) throw new PdfError('PDF защищён (зашифрован) — такие файлы не поддерживаются');
    if (!this.trailer.has('Root')) throw new PdfError('PDF повреждён — не удалось прочитать');
  }

  parseIndirectAt(offset, expect) {
    const lx = new Lexer(this.bytes, offset);
    const n = lx.word(), g = lx.word(), kw = lx.word();
    if (!/^\d+$/.test(n) || !/^\d+$/.test(g) || kw !== 'obj') throw new Error('нет объекта по адресу');
    if (expect !== undefined && +n !== expect) throw new Error('по адресу другой объект');
    const v = lx.value();
    if (isDict(v) && lx.peekWord() === 'stream') {
      lx.word();
      const b = this.bytes;
      if (b[lx.pos] === 13) lx.pos++;
      if (b[lx.pos] === 10) lx.pos++;
      const start = lx.pos;
      let len = v.get('Length');
      if (len instanceof Ref) len = this.lengthOf(len);
      let end = typeof len === 'number' && len >= 0 ? start + len : -1;
      // Проверяем, что после данных действительно «endstream»; иначе ищем его.
      const ok = end >= start && end <= b.length && /^\s*endstream/.test(latin1(b, end, Math.min(b.length, end + 20)));
      if (!ok) {
        const idx = indexOf(b, ENDSTREAM, start);
        if (idx < 0) throw new PdfError('Повреждённый поток в PDF');
        end = idx;
        while (end > start && (b[end - 1] === 10 || b[end - 1] === 13)) end--;
      }
      return new Stream(v, b.subarray(start, end));
    }
    return v;
  }

  // Длина потока, заданная ссылкой (только обычные объекты, без рекурсии в потоки).
  lengthOf(ref) {
    const e = this.xref.get(ref.num);
    if (!e || e.type !== 1) return -1;
    try {
      const v = new Lexer(this.bytes, e.offset);
      v.word(); v.word(); v.word();
      const n = v.value();
      return typeof n === 'number' ? n : -1;
    } catch { return -1; }
  }

  async loadObjStm(num_, stream) {
    let entry = this.objStms.get(num_);
    if (entry) return entry;
    stream = stream || await this.get(new Ref(num_, 0));
    if (!(stream instanceof Stream)) throw new PdfError('Повреждённый PDF');
    const data = await this.decode(stream);
    const n = num(stream.dict.get('N'), 0), first = num(stream.dict.get('First'), 0);
    const lx = new Lexer(data);
    const offsets = [], positions = [];
    for (let i = 0; i < n; i++) { offsets.push(+lx.word()); positions.push(+lx.word()); }
    entry = { data, first, offsets, positions };
    this.objStms.set(num_, entry);
    return entry;
  }

  /** Значение по ссылке (или само значение, если это не ссылка). */
  async get(v) {
    if (!(v instanceof Ref)) return v;
    if (this.cache.has(v.num)) return this.cache.get(v.num);
    const e = this.xref.get(v.num);
    let obj = null;
    try {
      if (e?.type === 1) obj = this.parseIndirectAt(e.offset, v.num);
      else if (e?.type === 2) {
        const stm = await this.loadObjStm(e.stm);
        const lx = new Lexer(stm.data, stm.first + stm.positions[e.idx]);
        obj = lx.value();
      }
    } catch (err) {
      if (err instanceof PdfError && /зашифр/.test(err.message)) throw err;
      obj = null; // битый объект — как отсутствующий
    }
    this.cache.set(v.num, obj);
    return obj;
  }

  /** Распакованные данные потока. */
  async decode(stream) {
    const r = await decodeStream(stream, new Set(), v => this.get(v));
    if (r.filters.length) throw new PdfError('Неподдерживаемый способ сжатия в PDF: ' + r.filters[0]?.n);
    return r.data;
  }

  /**
   * Явное назначение ([страница /XYZ …]) по имени ссылки: /Dest /имя ищется в
   * каталоге /Dests, /Dest (строка) — в дереве /Names /Dests. null — не найдено.
   */
  async namedDest(v) {
    v = await this.get(v);
    const key = v instanceof Name ? 'n:' + v.n : v instanceof Str ? 's:' + latin1(v.bytes) : null;
    if (!key) return null;
    this.destCache ??= new Map();
    if (this.destCache.has(key)) return this.destCache.get(key);
    let found = null;
    const explicit = async x => {
      x = await this.get(x);
      if (isDict(x)) x = await this.get(x.get('D'));
      return Array.isArray(x) ? x : null;
    };
    try {
      const root = await this.get(this.trailer.get('Root'));
      if (v instanceof Name) {
        const dests = isDict(root) ? await this.get(root.get('Dests')) : null;
        if (isDict(dests) && dests.has(v.n)) found = await explicit(dests.get(v.n));
      } else {
        const names = isDict(root) ? await this.get(root.get('Names')) : null;
        const want = latin1(v.bytes);
        // Поиск по дереву имён: спускаемся только в узлы, чьи /Limits включают имя.
        const seen = new Set();
        const search = async (node, depth) => {
          node = await this.get(node);
          if (!isDict(node) || depth > 32 || seen.has(node)) return null;
          seen.add(node);
          const lim = await this.get(node.get('Limits'));
          if (Array.isArray(lim) && lim[0] instanceof Str && lim[1] instanceof Str) {
            if (want < latin1(lim[0].bytes) || want > latin1(lim[1].bytes)) return null;
          }
          const arr = await this.get(node.get('Names'));
          if (Array.isArray(arr)) {
            for (let i = 0; i + 1 < arr.length; i += 2) {
              const k = await this.get(arr[i]);
              if (k instanceof Str && latin1(k.bytes) === want) return explicit(arr[i + 1]);
            }
          }
          for (const kid of asArray(await this.get(node.get('Kids')))) {
            const r = await search(kid, depth + 1);
            if (r) return r;
          }
          return null;
        };
        if (isDict(names)) found = await search(names.get('Dests'), 0);
      }
    } catch { found = null; }
    this.destCache.set(key, found);
    return found;
  }

  // Страницы по порядку: [{ ref, dict, inherited }], наследуемые атрибуты собраны.
  async collectPages() {
    const root = await this.get(this.trailer.get('Root'));
    const out = [];
    const seen = new Set();
    const walk = async (ref, inh, depth) => {
      if (depth > 64) return;
      const node = await this.get(ref);
      if (!isDict(node)) { this.missingPages++; return; }
      if (ref instanceof Ref) {
        if (seen.has(ref.num)) return;
        seen.add(ref.num);
      }
      const next = { ...inh };
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node.has(k)) next[k] = node.get(k);
      const kids = await this.get(node.get('Kids'));
      if (isName(node.get('Type'), 'Pages') || (Array.isArray(kids) && !isName(node.get('Type'), 'Page'))) {
        for (const k of asArray(kids)) await walk(k, next, depth + 1);
      } else if (ref instanceof Ref) {
        out.push({ ref, dict: node, inherited: next });
      }
    };
    this.missingPages = 0;
    if (isDict(root)) await walk(root.get('Pages'), {}, 0);
    return out;
  }
}

const ENDSTREAM = new TextEncoder().encode('endstream');
function indexOf(hay, needle, from) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}
