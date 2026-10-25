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
  const small = drawScaled(canvas, 320);
  const sw = small.width, sh = small.height;
  const sctx = ctx2d(small);
  const sdata = sctx.getImageData(0, 0, sw, sh);
  const s = sdata.data;
  let g = new Float32Array(sw * sh);
  for (let i = 0; i < g.length; i++) g[i] = lum(s[i * 4], s[i * 4 + 1], s[i * 4 + 2]);
  // Морфологическое закрытие (максимум, затем минимум с тем же окном):
  // тёмное содержимое меньше окна — текст, заголовки, плашки таблиц, фото —
  // убирается из оценки фона и остаётся на странице; тени шире окна
  // возвращаются в фон с чёткими границами (без тёмной полосы у края тени);
  // плавные перепады освещения закрытие сохраняет как есть.
  // Окно — около 20% длинной стороны: компромисс между ними.
  const r = Math.max(2, Math.round(Math.max(sw, sh) * 0.1));
  g = minMax1d(g, sw, sh, r, true, true);
  g = minMax1d(g, sw, sh, r, true, false);
  g = minMax1d(g, sw, sh, r, false, true);
  g = minMax1d(g, sw, sh, r, false, false);
  g = blur(g, sw, sh, 1);
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

// Максимум (isMax) или минимум по окну радиуса r вдоль строк или столбцов.
// Монотонная очередь: O(n) при любом r. Края — повтором крайнего пикселя.
function minMax1d(src, w, h, r, isMax, horizontal) {
  const out = new Float32Array(src.length);
  const len = horizontal ? w : h, lines = horizontal ? h : w;
  const step = horizontal ? 1 : w;
  const q = new Int32Array(len + 2 * r + 1); // индексы в линии (с учётом выхода за края)
  const better = isMax ? (a, b) => a >= b : (a, b) => a <= b;
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    const at = k => src[base + Math.min(len - 1, Math.max(0, k)) * step];
    let head = 0, tail = 0;
    for (let k = -r; k < len + r; k++) {
      const v = at(k);
      while (tail > head && better(v, at(q[tail - 1]))) tail--;
      q[tail++] = k;
      const c = k - r; // центр окна [c - r, c + r]
      if (c < 0) continue;
      while (q[head] < c - r) head++;
      out[base + c * step] = at(q[head]);
    }
  }
  return out;
}


// Растяжка контраста с осторожным балансом белого.
// Если канал лишь немного «не дотягивает» (жёлтый свет лампы на белом листе),
// он выравнивается. Если сильно (жёлтая грамота, голубой бланк) — это цвет
// бумаги, и он сохраняется.
function autoLevels(d) {
  const n = d.length / 4;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < d.length; i += 4) {
    hist[0][d[i]]++; hist[1][d[i + 1]]++; hist[2][d[i + 2]]++;
  }
  const los = [], his = [];
  for (const hs of hist) {
    let l = 0, h = 255, acc = 0;
    while (l < 255 && (acc += hs[l]) < n * 0.01) l++;
    acc = 0;
    while (h > 0 && (acc += hs[h]) < n * 0.005) h--;
    los.push(l);
    his.push(h);
  }
  const lo = Math.min(...los), hiMax = Math.max(...his);
  if (hiMax - lo < 48) return;
  const luts = his.map(hc => {
    const ratio = hc / hiMax;
    const k = Math.min(1, Math.max(0, (ratio - 0.55) / (0.7 - 0.55)));
    const hi = Math.max(lo + 48, hiMax + (hc - hiMax) * k);
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = ((v - lo) * 255) / (hi - lo);
    return lut;
  });
  for (let i = 0; i < d.length; i += 4) {
    d[i] = luts[0][d[i]];
    d[i + 1] = luts[1][d[i + 1]];
    d[i + 2] = luts[2][d[i + 2]];
  }
}

export const FILTERS = ['original', 'enhance', 'color', 'gray', 'doc', 'bw'];

// ---------- Чёткость текста ----------
// Как в камерах телефонов: «нерезкая маска» по яркости (без цветных ореолов)
// с порогом, чтобы не усиливать шум на бумаге, плюс слабый локальный контраст
// на крупном масштабе. Радиусы — от размера снимка (≈ для страницы A4).

// Размытие прямоугольным окном радиуса r по строкам и столбцам (бегущая сумма,
// O(n)). Пишет в dst (можно dst === src); tmp — рабочий буфер того же размера.
function boxBlurInto(src, dst, tmp, w, h, r) {
  const norm = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = src[o] * (r + 1);
    for (let x = 1; x <= r; x++) acc += src[o + Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = acc * norm;
      acc += src[o + Math.min(x + r + 1, w - 1)] - src[o + Math.max(x - r, 0)];
    }
  }
  // По столбцам — но обходом строк (суммы всех столбцов сразу): так память
  // читается подряд, и это в разы быстрее обхода по столбцам.
  const acc = new Float32Array(w);
  for (let x = 0; x < w; x++) acc[x] = tmp[x] * (r + 1);
  for (let y = 1; y <= r; y++) {
    const o = Math.min(y, h - 1) * w;
    for (let x = 0; x < w; x++) acc[x] += tmp[o + x];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w, add = Math.min(y + r + 1, h - 1) * w, sub = Math.max(y - r, 0) * w;
    for (let x = 0; x < w; x++) {
      dst[o + x] = acc[x] * norm;
      acc[x] += tmp[add + x] - tmp[sub + x];
    }
  }
  return dst;
}

// Почти гауссово размытие (два прохода прямоугольным окном) в новый массив.
function blur(src, w, h, r, tmp = new Float32Array(src.length)) {
  const out = boxBlurInto(src, new Float32Array(src.length), tmp, w, h, r);
  return boxBlurInto(out, out, tmp, w, h, r);
}

// Уменьшенная в k раз и размытая копия яркости — для локального контраста.
function wideSmall(L, w, h, r, k) {
  const sw = Math.max(1, Math.ceil(w / k)), sh = Math.max(1, Math.ceil(h / k));
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const row = ((y / k) | 0) * sw;
    for (let x = 0; x < w; x++) small[row + ((x / k) | 0)] += L[y * w + x];
  }
  // Число пикселей в ячейке: k×k, у последних строки/столбца — меньше.
  for (let cy = 0; cy < sh; cy++) {
    const ch = Math.min(k, h - cy * k);
    for (let cx = 0; cx < sw; cx++) small[cy * sw + cx] /= ch * Math.min(k, w - cx * k);
  }
  return { b: blur(small, sw, sh, Math.max(1, Math.round(r / k))), sw, sh };
}

// Уровень шума снимка: медиана |L − размытое| (большая часть кадра — ровная
// бумага, поэтому медиана — это шум, а не края букв). Возвращает σ.
function noiseSigma(L, fine) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < L.length; i += 7) {
    hist[Math.min(255, Math.round(Math.abs(L[i] - fine[i]) * 4))]++;
    n++;
  }
  let acc = 0, m = 0;
  while (m < 255 && (acc += hist[m]) < n / 2) m++;
  return 1.4826 * (m / 4);
}

/**
 * Повышает чёткость. L — яркость (Float32Array, 0..255), w×h. Изменение яркости
 * добавляется в target: при stride 4 — к R, G, B картинки RGBA (не больше, чем
 * позволяет самый светлый/тёмный канал, чтобы не сдвигать цвет на краях), при
 * stride 1 — к самому массиву яркости (можно target === L).
 * Память: кроме L — два буфера того же размера.
 */
function sharpenLuma(L, w, h, target, stride) {
  const scale = Math.max(w, h) / 2480;               // 1 ≈ A4 при 300 dpi
  const rFine = Math.max(1, Math.round(1.5 * scale)); // штрих буквы — несколько пикселей
  const fine = blur(L, w, h, rFine);
  const k = Math.max(2, Math.round(6 * scale));
  const { b, sw, sh } = wideSmall(L, w, h, Math.max(4, 24 * scale), k);
  // Порог по шуму: зерно матрицы не усиливается, края букв — да.
  const t = Math.max(2, 3 * noiseSigma(L, fine));
  const AMOUNT = 1.2, CLARITY = 0.25;
  // Мягкий порог: плавно от нуля, без скачков яркости на плавных переходах.
  const core = v => (v > t ? v - t : v < -t ? v + t : 0);
  // Билинейная выборка из уменьшенной копии: индексы по x общие для всех строк.
  const X0 = new Int32Array(w), X1 = new Int32Array(w), TX = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) / k - 0.5));
    X0[x] = fx | 0; X1[x] = Math.min(X0[x] + 1, sw - 1); TX[x] = fx - X0[x];
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) / k - 0.5));
    const r0 = (fy | 0) * sw, r1 = Math.min((fy | 0) + 1, sh - 1) * sw, ty = fy - (fy | 0);
    for (let x = 0, i = y * w; x < w; x++, i++) {
      const top = b[r0 + X0[x]] + (b[r0 + X1[x]] - b[r0 + X0[x]]) * TX[x];
      const wide = top + (b[r1 + X0[x]] + (b[r1 + X1[x]] - b[r1 + X0[x]]) * TX[x] - top) * ty;
      let delta = AMOUNT * core(L[i] - fine[i]) + CLARITY * core(L[i] - wide);
      if (!delta) continue;
      if (stride === 1) { target[i] += delta; continue; }
      const j = i * 4, r = target[j], g = target[j + 1], bl = target[j + 2];
      if (delta > 0) delta = Math.min(delta, 255 - Math.max(r, g, bl));
      else delta = Math.max(delta, -Math.min(r, g, bl));
      target[j] = r + delta; target[j + 1] = g + delta; target[j + 2] = bl + delta;
    }
  }
}

function lumaOf(d) {
  const L = new Float32Array(d.length / 4);
  for (let i = 0, j = 0; i < L.length; i++, j += 4) L[i] = lum(d[j], d[j + 1], d[j + 2]);
  return L;
}


// Применяет фильтр к холсту на месте.
// sharpen: false — без повышения чёткости (для сравнения в тестах).
export function applyFilter(canvas, filter, { sharpen = true } = {}) {
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
    // Яркость относительно бумаги (тени убраны), 255 = бумага.
    const N = lumaOf(d);
    for (let i = 0; i < N.length; i++) N[i] = (N[i] / Math.max(bg[i * 4], 8)) * 255;
    // Чёткость — после удаления теней (края теней не усиливаются) и до перевода
    // в чёрно-белое (тонкие штрихи не рассыпаются).
    if (sharpen) sharpenLuma(N, w, h, N, 1);
    for (let i = 0; i < d.length; i += 4) {
      const r = N[i / 4] / 255;
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
  // Для цветных и серого — после выравнивания яркости и цвета.
  if (sharpen && (filter === 'enhance' || filter === 'color' || filter === 'gray')) sharpenLuma(lumaOf(d), w, h, d, 4);
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

// Из маски «лист / не лист» берёт самое крупное пятно (с приоритетом центра),
// заливает в нём дыры (тёмные фото, крупный текст) и находит 4 угла.
// Возвращает { quad, rect, area, center } или null:
// rect — насколько пятно похоже на четырёхугольник (у листа близко к 1),
// area — доля кадра, center — накрывает ли пятно центр кадра,
// frame — доля контура на краю кадра (пятно, слившееся с фоном, «прилипает» к краю).
function quadFromMask(mask, w, h) {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let bestLabel = -1, bestScore = 0, bestCenter = false, cur = 0;
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
    if (score > bestScore) { bestScore = score; bestLabel = cur; bestCenter = touchesCenter; }
    cur++;
  }
  if (bestLabel < 0) return null;

  // Всё, до чего нельзя дойти от края кадра в обход пятна, — внутри листа.
  const outside = new Uint8Array(n);
  let sp = 0;
  const seed = p => { if (label[p] !== bestLabel && !outside[p]) { outside[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp];
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < n - w) seed(p + w);
  }
  let filled = 0, onFrame = 0;
  const edge = [];
  for (let p = 0; p < n; p++) {
    if (outside[p]) continue;
    filled++;
    const x = p % w;
    const frame = x === 0 || x === w - 1 || p < w || p >= n - w;
    if (frame || outside[p - 1] || outside[p + 1] || outside[p - w] || outside[p + w]) {
      edge.push(p);
      if (frame) onFrame++;
    }
  }
  const area = filled / n;
  if (area < 0.08 || area > 0.97) return null;

  // Углы — крайние точки контура по диагональным направлениям. Перебираем
  // поворот направлений, чтобы находить углы и у сильно повёрнутого листа.
  let quad = null, qa = 0;
  for (let deg = 0; deg < 90; deg += 7.5) {
    const t = (deg + 45) * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    let maxU = -Infinity, minU = Infinity, maxV = -Infinity, minV = Infinity;
    let pMaxU = 0, pMinU = 0, pMaxV = 0, pMinV = 0;
    for (const p of edge) {
      const x = p % w, y = (p / w) | 0;
      const u = x * c + y * sn, v = y * c - x * sn;
      if (u > maxU) { maxU = u; pMaxU = p; }
      if (u < minU) { minU = u; pMinU = p; }
      if (v > maxV) { maxV = v; pMaxV = p; }
      if (v < minV) { minV = v; pMinV = p; }
    }
    const pts = [pMinU, pMaxV, pMaxU, pMinV].map(p => [((p % w) + 0.5) / w, (((p / w) | 0) + 0.5) / h]);
    const ordered = orderCorners(pts);
    const a = polygonArea(ordered);
    if (a > qa) { qa = a; quad = ordered; }
  }
  if (!quad || qa < 0.08) return null;
  return {
    quad,
    rect: Math.min(area, qa) / Math.max(area, qa),
    area,
    center: bestCenter,
    frame: onFrame / edge.length, // доля контура, лежащая на краю кадра
  };
}

// Упорядочивает 4 точки как TL, TR, BR, BL (по часовой стрелке на экране).
function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = [...pts].sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let start = 0;
  sorted.forEach((p, i) => { if (p[0] + p[1] < sorted[start][0] + sorted[start][1]) start = i; });
  return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
}

// Ищет лист на фоне четырьмя способами — по яркости, по отличию цвета от фона,
// по оттенку (жёлтые грамоты, цветные бланки) и заливкой фона от краёв кадра
// (листы с тёмной узорной рамкой) — и берёт лучший результат.
// Возвращает углы (TL, TR, BR, BL) в долях от размера или null.
export function detectDocument(canvas) {
  const small = drawScaled(canvas, 320);
  const w = small.width, h = small.height;
  const s = ctx2d(small).getImageData(0, 0, w, h).data;
  const n = w * h;
  const ch = [0, 1, 2].map(c => {
    let a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = s[i * 4 + c];
    return boxBlurInto(a, a, new Float32Array(a.length), w, h, 2);
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
  const bandIdx = []; // пиксели полосы у края кадра
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= band && x < w - band && y >= band && y < h - band) continue;
      const i = y * w + x;
      bandIdx.push(i);
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

  // 4) Заливка фона от краёв кадра: всё, что похоже на стол и связано с краем
  //    снимка, — фон, остальное — лист. Так находится лист с широкой тёмной
  //    узорной рамкой (грамоты, дипломы): узор отличается от стола, и заливка
  //    останавливается на краю листа, а способы выше видят только светлую середину.
  const flood = quadFromMask(backgroundFlood(D, w, h, bandIdx), w, h);
  if (flood) flood.flood = true;
  found.push(flood);

  // Важна и форма, и размер: цветная шапка или таблица внутри листа тоже
  // бывает ровным прямоугольником, но она меньше самого листа. Пятна,
  // слившиеся с фоном у края кадра, штрафуются. У настоящего листа вдоль всех
  // четырёх краёв изнутри — бумага одной яркости; рамка, захватившая тень или
  // предмет рядом, на одной из сторон заметно темнее.
  for (const f of found) if (f) f.sides = sideRatio(f.quad, L, w, h);
  const weight = f => f.rect ** 4 * Math.sqrt(f.area) * (f.center ? 1 : 0.6) *
    Math.max(0.1, 1 - 2 * f.frame) * Math.min(1, f.sides / 0.6);
  const ok = found.filter(f => f && f.rect >= 0.6).sort((a, b) => weight(b) - weight(a));
  if (!ok.length) return null;
  // Заливка — только если она лучше всех: её область всегда не меньше листа,
  // и при равенстве она отбирала бы победу у точного варианта.
  if (ok[0].flood) return ok[0].quad;
  // Почти равные варианты: берём больший — меньший обычно «откусил» край листа в тени.
  const close = ok.filter(f => !f.flood && weight(f) >= weight(ok[0]) * 0.85);
  return close.sort((a, b) => b.area - a.area)[0].quad;
}

// Маска «не фон»: заливка от краёв кадра по пикселям, близким к цвету фона.
// D — расстояние до цвета фона, bandIdx — пиксели полосы у края кадра.
// Допуск — по медиане разброса в полосе: даже если лист заходит в полосу
// (снято вплотную), медиана остаётся фоном.
// Ограничение: сильная тень, заходящая и на стол, и на лист при слабом
// контрасте листа со столом, — заливка затекает на лист (как и способы выше).
function backgroundFlood(D, w, h, bandIdx) {
  const n = w * h;
  const bandD = bandIdx.map(i => D[i]).sort((a, b) => a - b);
  const tol = Math.min(50, Math.max(15, 3 * bandD[bandD.length >> 1] + 10));
  const bg = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const seed = i => { if (!bg[i] && D[i] < tol) { bg[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  for (let i = 0; i < n; i++) bg[i] ^= 1;
  return bg;
}

// Яркость бумаги вдоль сторон четырёхугольника (чуть внутри): отношение самой
// тёмной стороны к самой светлой (1 — одинаково, у настоящего листа близко к 1).
function sideRatio(quad, L, w, h) {
  const cx = quad.reduce((s, p) => s + p[0], 0) / 4, cy = quad.reduce((s, p) => s + p[1], 0) / 4;
  const sides = [];
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = quad[k], [bx, by] = quad[(k + 1) % 4];
    const vals = [];
    for (let t = 0.1; t <= 0.9; t += 0.04) {
      // Точка на стороне, сдвинутая на 4% к центру.
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      const x = Math.round((px + (cx - px) * 0.04) * w - 0.5), y = Math.round((py + (cy - py) * 0.04) * h - 0.5);
      if (x >= 0 && x < w && y >= 0 && y < h) vals.push(L[y * w + x]);
    }
    vals.sort((a, b) => a - b);
    sides.push(vals.length ? vals[vals.length >> 1] : 0);
  }
  return (Math.min(...sides) + 1) / (Math.max(...sides) + 1);
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
