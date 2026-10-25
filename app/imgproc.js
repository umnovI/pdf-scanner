// Обработка изображений: поворот, выравнивание перспективы, фильтры, поиск краёв.

export const MAX_SRC = 3000;   // длинная сторона сохраняемого оригинала
export const MAX_OUT = 2480;   // длинная сторона готовой страницы (~A4 при 300 dpi)
export const FULL_FRAME = [[0, 0], [1, 0], [1, 1], [0, 1]]; // TL, TR, BR, BL

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function ctx2d(c) {
  return c.getContext('2d', { willReadFrequently: true });
}

function size(img) {
  return [img.naturalWidth || img.width, img.naturalHeight || img.height];
}

// Открывает файл картинки с учётом EXIF-ориентации.
export async function decode(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (e) { /* пробуем через <img> */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть изображение')); };
    img.src = url;
  });
}

export function release(img) {
  if (img && typeof img.close === 'function') img.close();
}

export function drawScaled(img, maxSide) {
  const [w, h] = size(img);
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(w * k, h * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export function toBlob(canvas, quality = 0.9) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Не удалось сохранить изображение'))), 'image/jpeg', quality);
  });
}

// Поворот на 0/90/180/270 градусов по часовой стрелке.
export function rotateCanvas(src, deg) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return src;
  const c = deg === 180 ? makeCanvas(src.width, src.height) : makeCanvas(src.height, src.width);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(deg * Math.PI / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

// Пересчёт углов рамки при повороте картинки (dir = 1 по часовой, -1 против).
export function rotateCorners(c, dir) {
  if (dir > 0) {
    const m = c.map(([x, y]) => [1 - y, x]);
    return [m[3], m[0], m[1], m[2]];
  }
  const m = c.map(([x, y]) => [y, 1 - x]);
  return [m[1], m[2], m[3], m[0]];
}

export function isFullFrame(c) {
  return c.every(([x, y], i) => Math.abs(x - FULL_FRAME[i][0]) < 1e-3 && Math.abs(y - FULL_FRAME[i][1]) < 1e-3);
}

// Проективное отображение единичного квадрата на четырёхугольник p (TL, TR, BR, BL).
function squareToQuad(p) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
  const dx3 = x0 - x1 + x2 - x3, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
    return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0];
  }
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

// Вырезает четырёхугольник и выпрямляет его в прямоугольник.
export function warp(src, corners) {
  const sw = src.width, sh = src.height;
  const p = corners.map(([x, y]) => [x * sw, y * sh]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(dist(p[0], p[1]), dist(p[3], p[2]));
  let H = Math.max(dist(p[0], p[3]), dist(p[1], p[2]));
  const k = Math.min(1, MAX_OUT / Math.max(W, H));
  W = Math.max(1, Math.round(W * k));
  H = Math.max(1, Math.round(H * k));

  const sd = ctx2d(src).getImageData(0, 0, sw, sh).data;
  const out = makeCanvas(W, H);
  const octx = out.getContext('2d');
  const od = octx.createImageData(W, H);
  const o = od.data;
  const [a, b, c, d, e, f, g, h] = squareToQuad(p);
  const maxX = sw - 1, maxY = sh - 1;
  let i = 0;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++, i += 4) {
      const u = (x + 0.5) / W;
      const den = g * u + h * v + 1;
      let sx = (a * u + b * v + c) / den - 0.5;
      let sy = (d * u + e * v + f) / den - 0.5;
      if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
      if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx;
        const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx;
        o[i + ch] = top + (bot - top) * fy;
      }
      o[i + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// ---------- Фильтры ----------

function lum(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Оценка яркости «бумаги» в каждой точке (для удаления теней).
function background(canvas) {
  const w = canvas.width, h = canvas.height;
  const small = drawScaled(canvas, 160);
  const sw = small.width, sh = small.height;
  const sctx = ctx2d(small);
  const sdata = sctx.getImageData(0, 0, sw, sh);
  const s = sdata.data;
  let g = new Float32Array(sw * sh);
  for (let i = 0; i < g.length; i++) g[i] = lum(s[i * 4], s[i * 4 + 1], s[i * 4 + 2]);
  // Максимум по окну убирает текст, усреднение сглаживает.
  g = filter1d(g, sw, sh, 3, Math.max, true);
  g = filter1d(g, sw, sh, 3, Math.max, false);
  for (let pass = 0; pass < 2; pass++) {
    g = boxBlur(g, sw, sh, 4, true);
    g = boxBlur(g, sw, sh, 4, false);
  }
  for (let i = 0; i < g.length; i++) {
    const v = g[i];
    s[i * 4] = s[i * 4 + 1] = s[i * 4 + 2] = v;
    s[i * 4 + 3] = 255;
  }
  sctx.putImageData(sdata, 0, 0);
  const big = makeCanvas(w, h);
  const bctx = ctx2d(big);
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);
  return bctx.getImageData(0, 0, w, h).data;
}

function filter1d(src, w, h, r, fn, horizontal) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = -r; k <= r; k++) {
        const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
        const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
        m = fn(m, src[yy * w + xx]);
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

function boxBlur(src, w, h, r, horizontal) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) {
        const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
        const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
        sum += src[yy * w + xx];
      }
      out[y * w + x] = sum / (2 * r + 1);
    }
  }
  return out;
}

// Растяжка контраста. Общие границы для всех каналов — цвет бумаги
// (жёлтая грамота, голубой бланк) не превращается в белый.
function autoLevels(d) {
  const n = d.length / 4;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < d.length; i += 4) {
    hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++;
  }
  let lo = 255, hi = 0;
  for (const hs of hist) {
    let l = 0, h = 255, acc = 0;
    while (l < 255 && (acc += hs[l]) < n * 0.01) l++;
    acc = 0;
    while (h > 0 && (acc += hs[h]) < n * 0.005) h--;
    lo = Math.min(lo, l);
    hi = Math.max(hi, h);
  }
  if (hi - lo < 48) return;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = lut[d[i]];
    d[i + 1] = lut[d[i + 1]];
    d[i + 2] = lut[d[i + 2]];
  }
}

export const FILTERS = ['original', 'enhance', 'color', 'gray', 'doc', 'bw'];

// Применяет фильтр к холсту на месте.
export function applyFilter(canvas, filter) {
  if (!filter || filter === 'original') return canvas;
  const ctx = ctx2d(canvas);
  const w = canvas.width, h = canvas.height;
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  if (filter === 'enhance') {
    autoLevels(d);
  } else if (filter === 'color') {
    // Убираем тени и неровный свет, сохраняя цвет бумаги и печатей.
    const bg = background(canvas);
    const sample = [];
    for (let i = 0; i < bg.length; i += 4 * 97) sample.push(bg[i]);
    sample.sort((x, y) => x - y);
    const target = Math.max(120, sample[Math.floor(sample.length * 0.97)] || 255);
    for (let i = 0; i < d.length; i += 4) {
      let k = target / Math.max(bg[i], 8);
      if (k < 0.8) k = 0.8; else if (k > 3) k = 3;
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
    autoLevels(d);
  } else if (filter === 'gray') {
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = lum(d[i], d[i + 1], d[i + 2]);
    }
    autoLevels(d);
  } else if (filter === 'doc' || filter === 'bw') {
    const bg = background(canvas);
    const bw = filter === 'bw';
    for (let i = 0; i < d.length; i += 4) {
      const r = lum(d[i], d[i + 1], d[i + 2]) / Math.max(bg[i], 8);
      let v;
      if (bw) {
        v = r < 0.78 ? 0 : 255;
      } else {
        const t = (r - 0.35) / (0.92 - 0.35);
        v = t <= 0 ? 0 : t >= 1 ? 255 : 255 * t;
      }
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

// ---------- Поиск краёв документа ----------

function otsu(values) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, values[i] | 0))]++;
  const n = values.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// Из маски «лист / не лист» берёт самое крупное пятно (с приоритетом центра)
// и находит его 4 угла. Возвращает { quad, score } или null.
function quadFromMask(mask, w, h) {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let bestLabel = -1, bestScore = 0, bestCount = 0, cur = 0;
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start] !== -1) continue;
    let sp = 0, count = 0, touchesCenter = false;
    stack[sp++] = start;
    label[start] = cur;
    while (sp) {
      const p = stack[--sp];
      count++;
      const x = p % w, y = (p / w) | 0;
      if (Math.abs(x - w / 2) < w * 0.1 && Math.abs(y - h / 2) < h * 0.1) touchesCenter = true;
      if (x > 0 && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = cur; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = cur; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && label[p - w] === -1) { label[p - w] = cur; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && label[p + w] === -1) { label[p + w] = cur; stack[sp++] = p + w; }
    }
    const score = count * (touchesCenter ? 2 : 1);
    if (score > bestScore) { bestScore = score; bestLabel = cur; bestCount = count; }
    cur++;
  }
  if (bestLabel < 0 || bestCount < n * 0.08 || bestCount > n * 0.97) return null;

  let tl, tr, br, bl;
  let mTL = Infinity, mTR = -Infinity, mBR = -Infinity, mBL = Infinity;
  for (let p = 0; p < n; p++) {
    if (label[p] !== bestLabel) continue;
    const x = p % w, y = (p / w) | 0;
    const s1 = x + y, s2 = x - y;
    if (s1 < mTL) { mTL = s1; tl = [x, y]; }
    if (s1 > mBR) { mBR = s1; br = [x, y]; }
    if (s2 > mTR) { mTR = s2; tr = [x, y]; }
    if (s2 < mBL) { mBL = s2; bl = [x, y]; }
  }
  const quad = [tl, tr, br, bl].map(([x, y]) => [(x + 0.5) / w, (y + 0.5) / h]);
  const qa = polygonArea(quad);
  if (qa < 0.08) return null;
  // Насколько пятно похоже на четырёхугольник: у листа близко к 1.
  return { quad, score: Math.min(bestCount / n, qa) / Math.max(bestCount / n, qa) };
}

// Ищет лист на фоне двумя способами — по яркости и по отличию цвета от фона
// (для жёлтых грамот, цветных бланков и т.п.) — и берёт лучший результат.
// Возвращает углы (TL, TR, BR, BL) в долях от размера или null.
export function detectDocument(canvas) {
  const small = drawScaled(canvas, 320);
  const w = small.width, h = small.height;
  const s = ctx2d(small).getImageData(0, 0, w, h).data;
  const n = w * h;
  const ch = [0, 1, 2].map(c => {
    let a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = s[i * 4 + c];
    return boxBlur(boxBlur(a, w, h, 2, true), w, h, 2, false);
  });
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lum(ch[0][i], ch[1][i], ch[2][i]);

  const found = [];

  // 1) По яркости: лист обычно светлее фона; если в центре тёмное — наоборот.
  const tl = otsu(L);
  const light = L[(h >> 1) * w + (w >> 1)] > tl;
  const m1 = new Uint8Array(n);
  for (let i = 0; i < n; i++) m1[i] = (L[i] > tl) === light ? 1 : 0;
  found.push(quadFromMask(m1, w, h));

  // 2) По цвету: чем пиксель отличается от цвета фона по краям кадра.
  const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const border = [[], [], []];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= band && x < w - band && y >= band && y < h - band) continue;
      const i = y * w + x;
      for (let c = 0; c < 3; c++) border[c].push(ch[c][i]);
    }
  }
  const bgc = border.map(a => { a.sort((x, y) => x - y); return a[a.length >> 1]; });
  const D = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dr = ch[0][i] - bgc[0], dg = ch[1][i] - bgc[1], db = ch[2][i] - bgc[2];
    D[i] = Math.min(255, Math.sqrt(dr * dr + dg * dg + db * db));
  }
  const td = otsu(D);
  if (td > 12) {
    const m2 = new Uint8Array(n);
    for (let i = 0; i < n; i++) m2[i] = D[i] > td ? 1 : 0;
    found.push(quadFromMask(m2, w, h));
  }

  // 3) По оттенку (без учёта яркости) — тени почти не мешают.
  const chroma = i => {
    const sum = ch[0][i] + ch[1][i] + ch[2][i] + 1;
    return [ch[0][i] / sum, ch[1][i] / sum];
  };
  const bsum = bgc[0] + bgc[1] + bgc[2] + 1;
  const bch = [bgc[0] / bsum, bgc[1] / bsum];
  const C = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (ch[0][i] + ch[1][i] + ch[2][i] < 45) continue; // слишком тёмное — оттенок ненадёжен
    const [cr, cg] = chroma(i);
    C[i] = Math.min(255, Math.hypot(cr - bch[0], cg - bch[1]) * 1500);
  }
  const tc = otsu(C);
  if (tc > 12) {
    const m3 = new Uint8Array(n);
    for (let i = 0; i < n; i++) m3[i] = C[i] > tc ? 1 : 0;
    found.push(quadFromMask(m3, w, h));
  }

  const best = found.filter(Boolean).sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0.8 ? best.quad : null;
}

function polygonArea(q) {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// Полная обработка страницы: оригинал → поворот → рамка → фильтр.
export async function renderPage(page) {
  const img = await decode(page.src);
  let c = drawScaled(img, MAX_SRC);
  release(img);
  c = rotateCanvas(c, page.rotation);
  c = isFullFrame(page.corners) ? drawScaled(c, MAX_OUT) : warp(c, page.corners);
  applyFilter(c, page.filter);
  return c;
}
