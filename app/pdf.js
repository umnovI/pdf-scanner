// Минимальный генератор PDF: каждая страница — одна JPEG-картинка.
// JPEG вставляется как есть (фильтр DCTDecode), без перекодирования.

const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

// Читает размеры и число цветовых каналов из заголовка JPEG.
export function jpegInfo(bytes) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw new Error('Не JPEG');
  let p = 2;
  while (p + 9 < bytes.length) {
    if (bytes[p] !== 0xFF) { p++; continue; }
    const marker = bytes[p + 1];
    if (marker === 0xFF) { p++; continue; }
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { p += 2; continue; }
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    const isSOF = marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
    if (isSOF) {
      return {
        height: (bytes[p + 5] << 8) | bytes[p + 6],
        width: (bytes[p + 7] << 8) | bytes[p + 8],
        components: bytes[p + 9],
      };
    }
    p += 2 + len;
  }
  throw new Error('Повреждённый JPEG');
}

const num = v => (Math.round(v * 100) / 100).toString();

// Все страницы одного размера (всегда книжная ориентация).
// Возвращает [ширина страницы, высота страницы, x, y, ширина картинки, высота картинки] в пунктах.
// fit = 'fill' — картинка растягивается на всю страницу, иначе вписывается с сохранением пропорций.
function layout(iw, ih, sizeName, margin, fit) {
  const [pw, ph] = PAGE_SIZES[sizeName] || PAGE_SIZES.a4;
  const aw = pw - 2 * margin, ah = ph - 2 * margin;
  if (fit === 'fill') return [pw, ph, margin, margin, aw, ah];
  const k = Math.min(aw / iw, ah / ih);
  const dw = iw * k, dh = ih * k;
  return [pw, ph, (pw - dw) / 2, (ph - dh) / 2, dw, dh];
}

function pdfString(s) {
  // Строка в UTF-16BE с BOM, в шестнадцатеричном виде — так кириллица читается везде.
  let hex = 'FEFF';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code > 0xFFFF) {
      const c = code - 0x10000;
      hex += (0xD800 + (c >> 10)).toString(16).padStart(4, '0');
      hex += (0xDC00 + (c & 0x3FF)).toString(16).padStart(4, '0');
    } else {
      hex += code.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())})`;
}

/**
 * @param {Blob[]} jpegs  JPEG-картинки страниц по порядку
 * @param {{size?: string, margin?: number, fit?: string, title?: string}} opts
 * @returns {Promise<Blob>}
 */
export async function buildPdf(jpegs, opts = {}) {
  const size = opts.size || 'a4';
  const margin = Number(opts.margin) || 0;
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let offset = 0;
  const push = data => {
    const u = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(u);
    offset += u.length;
  };
  const obj = (id, write) => {
    offsets[id] = offset;
    push(`${id} 0 obj\n`);
    write();
    push('\nendobj\n');
  };

  const n = jpegs.length;
  const infoId = 3 + 3 * n;
  const total = infoId;

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

  obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  const kids = jpegs.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  obj(2, () => push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>`));

  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(await jpegs[i].arrayBuffer());
    const info = jpegInfo(bytes);
    const [pw, ph, x, y, dw, dh] = layout(info.width, info.height, size, margin, opts.fit);
    const pageId = 3 + 3 * i, contentId = pageId + 1, imageId = pageId + 2;
    const content = `q ${num(dw)} 0 0 ${num(dh)} ${num(x)} ${num(y)} cm /Im0 Do Q`;
    const cs = info.components === 1 ? '/DeviceGray' : info.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';

    obj(pageId, () => push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(pw)} ${num(ph)}] ` +
      `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    obj(contentId, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
    obj(imageId, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
        `/ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
      push(bytes);
      push('\nendstream');
    });
  }

  obj(infoId, () => push(
    `<< /Producer ${pdfString('Сканер PDF')} /Title ${pdfString(opts.title || 'Скан')} ` +
    `/CreationDate ${pdfDate(new Date())} >>`));

  const xref = offset;
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
