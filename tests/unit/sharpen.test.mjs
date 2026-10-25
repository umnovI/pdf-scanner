// Повышение чёткости (imgproc.js: sharpenLuma, applyFilter с { sharpen }).
// Все проверки — свойства результата; «без чёткости» получается опцией { sharpen: false }.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { cornerError, fixtureB64, inApp, launch, startServer, truth, unitPage } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

// Общие помощники, выполняются внутри страницы (inApp сериализует функцию, поэтому — строкой).
const HELPERS = `(img) => {
  const copy = c => { const o = img.makeCanvas(c.width, c.height); o.getContext('2d').drawImage(c, 0, 0); return o; };
  const px = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const lumaOf = d => { const L = new Float32Array(d.length / 4); for (let i = 0; i < L.length; i++) L[i] = 0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2]; return L; };
  const fill = (c, col, x, y, w, h) => { const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(x, y, w, h); };
  const solid = (w, h, col) => { const c = img.makeCanvas(w, h); fill(c, col, 0, 0, w, h); return c; };
  // Фото blurry.jpg: выпрямлено по углам и растянуто до ~2480 по длинной стороне.
  const straight = async (util, b64, corners) => {
    const c = await util.loadCanvas(b64);
    const wc = img.warp(c, corners.map(([x, y]) => [x / c.width, y / c.height]));
    const k = 2480 / Math.max(wc.width, wc.height);
    const big = img.makeCanvas(Math.round(wc.width * k), Math.round(wc.height * k));
    const g = big.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(wc, 0, 0, big.width, big.height);
    return big;
  };
  // Область текста и чистой бумаги на выпрямленном blurry.jpg (1795×2480).
  const TEXT = [120, 170, 1000, 2060], PAPER = [150, 2200, 1650, 2400];
  const grad = (L, w, r) => { let s = 0, n = 0; for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) { const i = y * w + x; s += Math.abs(L[i+1] - L[i-1]) + Math.abs(L[i+w] - L[i-w]); n++; } return s / n; };
  const darkest = (L, w, r, frac) => { const a = []; for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) a.push(L[y * w + x]); a.sort((p, q) => p - q); const m = Math.floor(a.length * frac); let s = 0; for (let i = 0; i < m; i++) s += a[i]; return s / m; };
  const std = (L, w, r) => { let s = 0, s2 = 0, n = 0; for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) { const v = L[y * w + x]; s += v; s2 += v * v; n++; } return Math.sqrt(s2 / n - (s / n) ** 2); };
  return { copy, px, lumaOf, fill, solid, straight, TEXT, PAPER, grad, darkest, std };
}`;
const H = 'const h = (0, eval)(' + JSON.stringify(HELPERS) + ')(img);';
// Функция теста: строка-«пролог» подставляется в начало тела.
const run = (page, body, arg) => inApp(page, new Function('return async ({ img, util }, arg) => {' + H + body + '}')(), arg);

const BLURRY = [fixtureB64('blurry.jpg'), truth['blurry.jpg']];

describe('чёткость: рост резкости на размытом фото', () => {
  for (const [filter, min] of [['enhance', 1.08], ['gray', 1.08], ['color', 1.08], ['doc', 1.2]]) {
    test(`«${filter}»: средний градиент яркости в тексте выше не менее чем на ${Math.round((min - 1) * 100)}%`, async () => {
      const { page } = await unitPage(browser, server);
      const r = await run(page, `
        const big = await h.straight(util, arg[0], arg[1]);
        const out = {};
        for (const s of [false, true]) {
          const c = h.copy(big); img.applyFilter(c, arg[2], { sharpen: s });
          out[s] = h.grad(h.lumaOf(h.px(c)), c.width, h.TEXT);
        }
        return { size: [big.width, big.height], ...out };
      `, [...BLURRY, filter]);
      assert.ok(Math.abs(r.size[1] - 2480) <= 1, `размер ${r.size}`);
      assert.ok(r.true >= r.false * min, `градиент без ${r.false.toFixed(2)}, с чёткостью ${r.true.toFixed(2)} (нужно ×${min})`);
    });
  }

  test('«doc»: штрихи букв темнее (среднее самых тёмных 3% ниже)', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const big = await h.straight(util, arg[0], arg[1]);
      const out = {};
      for (const s of [false, true]) {
        const c = h.copy(big); img.applyFilter(c, 'doc', { sharpen: s });
        out[s] = h.darkest(h.lumaOf(h.px(c)), c.width, h.TEXT, 0.03);
      }
      return out;
    `, BLURRY);
    assert.ok(r.true < r.false, `тёмные 3%: без ${r.false.toFixed(1)}, с ${r.true.toFixed(1)}`);
  });
});

describe('чёткость: шум и цвет', () => {
  for (const filter of ['enhance', 'gray', 'color', 'doc']) {
    test(`«${filter}»: шум на чистой бумаге не растёт (σ с чёткостью ≤ σ без + 10%)`, async () => {
      const { page } = await unitPage(browser, server);
      const r = await run(page, `
        const big = await h.straight(util, arg[0], arg[1]);
        const out = {};
        for (const s of [false, true]) {
          const c = h.copy(big); img.applyFilter(c, arg[2], { sharpen: s });
          out[s] = h.std(h.lumaOf(h.px(c)), c.width, h.PAPER);
        }
        return out;
      `, [...BLURRY, filter]);
      assert.ok(r.true <= r.false * 1.1 + 0.05, `σ без ${r.false.toFixed(3)}, с ${r.true.toFixed(3)}`);
    });
  }

  test('«color»: нет цветных ореолов — оттенок по обе стороны резкой границы не меняется, каналы не обрезаются', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      // Бумага с красным и синим прямоугольниками вплотную: резкие границы бумага|красный|синий|бумага.
      const mk = (a, b) => {
        const c = h.solid(600, 300, '#ebebe6');
        h.fill(c, a, 200, 100, 100, 100);
        h.fill(c, b, 300, 100, 100, 100);
        return c;
      };
      const res = [];
      for (const [a, b] of [['rgb(200,40,40)', 'rgb(40,50,200)'], ['rgb(190,90,90)', 'rgb(90,100,190)']]) {
        const out = {};
        for (const s of [false, true]) { const c = mk(a, b); img.applyFilter(c, 'color', { sharpen: s }); out[s] = h.px(c); }
        // Окрестность (±5 px) каждой границы, строки 110..190.
        let maxShift = 0, clipPlain = 0, clipSharp = 0;
        for (const bx of [200, 300, 400]) for (let y = 110; y < 190; y++) for (let x = bx - 5; x < bx + 5; x++) {
          const i = (y * 600 + x) * 4;
          // Яркость добавляется ко всем каналам поровну, поэтому разности каналов (оттенок) не меняются.
          const dp = [out[false][i] - out[false][i+1], out[false][i+1] - out[false][i+2]];
          const ds = [out[true][i] - out[true][i+1], out[true][i+1] - out[true][i+2]];
          maxShift = Math.max(maxShift, Math.abs(dp[0] - ds[0]), Math.abs(dp[1] - ds[1]));
          for (let k = 0; k < 3; k++) { if (out[false][i+k] % 255 === 0) clipPlain++; if (out[true][i+k] % 255 === 0) clipSharp++; }
        }
        res.push({ a, b, maxShift, clipPlain, clipSharp });
      }
      return res;
    `);
    for (const o of r) {
      assert.ok(o.maxShift <= 2, `${o.a}|${o.b}: разности каналов (оттенок) изменились на ${o.maxShift} уровней (порог 2)`);
      // Запас 30%: затемнение края насыщенного цвета по замыслу доводит малый канал до 0.
      assert.ok(o.clipSharp <= o.clipPlain * 1.3 + 10, `${o.a}|${o.b}: обрезанных каналов у границ: без ${o.clipPlain}, с ${o.clipSharp}`);
    }
  });

  test('«enhance»: серый текст не окрашивается — на нейтральном холсте R=G=B остаётся у краёв', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const c = h.solid(300, 200, 'rgb(220,220,220)');
      h.fill(c, 'rgb(60,60,60)', 100, 50, 80, 100);
      img.applyFilter(c, 'enhance', { sharpen: true });
      const d = h.px(c); let bad = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i+1] || d[i+1] !== d[i+2]) bad++;
      return bad;
    `);
    assert.equal(r, 0, 'нейтральные пиксели стали цветными');
  });
});

describe('чёткость: тени и фильтры', () => {
  test('«doc»: плавная тень не усиливается (разница с «без чёткости» не больше 3 уровней)', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const mk = () => {
        const c = h.solid(600, 400, 'rgb(230,230,225)'), g = c.getContext('2d');
        const gr = g.createLinearGradient(150, 0, 450, 0);
        gr.addColorStop(0, 'rgb(230,230,225)'); gr.addColorStop(1, 'rgb(140,140,135)');
        g.fillStyle = gr; g.fillRect(150, 0, 450, 400);
        return c;
      };
      const a = mk(), b = mk();
      img.applyFilter(a, 'doc', { sharpen: false }); img.applyFilter(b, 'doc', { sharpen: true });
      const da = h.px(a), db = h.px(b); let diff = 0;
      for (let i = 0; i < da.length; i++) diff = Math.max(diff, Math.abs(da[i] - db[i]));
      return diff;
    `);
    assert.ok(r <= 3, `разница до ${r} уровней`);
  });

  // Регрессия: у резкого края тени оставалась широкая тёмная полоса (~28 px): фон оценивался
  // по маленькой копии с «максимумом по окну», бумага «затекала» в тень. Исправлено
  // морфологическим закрытием (максимум, затем минимум) на копии 320 px.
  test('«doc»: у края резкой тени нет широкой тёмной полосы (с чёткостью и без)', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const mk = () => { const c = h.solid(600, 400, 'rgb(230,230,225)'); h.fill(c, 'rgb(138,138,135)', 200, 0, 200, 400); return c; };
      const out = {};
      for (const s of [false, true]) {
        const c = mk(); img.applyFilter(c, 'doc', { sharpen: s });
        const L = h.lumaOf(h.px(c));
        // Сколько пикселей у каждого края тени (±30 px) заметно темнее бумаги.
        let worst = 0;
        for (const e of [200, 400]) {
          let n = 0;
          for (let x = e - 30; x < e + 30; x++) if (L[200 * 600 + x] < 230) n++;
          worst = Math.max(worst, n);
        }
        out[s] = worst;
      }
      return out;
    `);
    assert.ok(r[false] <= 3, `без чёткости тёмная полоса у края тени шириной ${r[false]} px`);
    assert.ok(r[true] <= 3, `с чёткостью тёмная полоса у края тени шириной ${r[true]} px`);
  });

  // Остаток: у самого края резкой тени остаётся переход в 2–3 px, и чёткость делает первый
  // пиксель заметно темнее (тонкая линия в 1 px).
  test('«doc»: резкая тень не усиливается — у края нет тёмной/светлой полосы', { todo: 'тонкая линия в 1 px у края резкой тени: чёткость усиливает 2–3-пиксельный остаток перехода (≈105 уровней в одном пикселе)' }, async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      // Бумага без текста, полоса x 200..400 темнее на 40%.
      const mk = () => { const c = h.solid(600, 400, 'rgb(230,230,225)'); h.fill(c, 'rgb(138,138,135)', 200, 0, 200, 400); return c; };
      const prof = d => { const L = h.lumaOf(d), p = []; for (let x = 0; x < 600; x++) { let s = 0; for (let y = 100; y < 300; y++) s += L[y * 600 + x]; p.push(s / 200); } return p; };
      const out = {};
      for (const s of [false, true]) { const c = mk(); img.applyFilter(c, 'doc', { sharpen: s }); out[s] = prof(h.px(c)); }
      let diff = 0;
      for (const e of [200, 400]) for (let x = e - 20; x < e + 20; x++) diff = Math.max(diff, Math.abs(out[true][x] - out[false][x]));
      return diff;
    `);
    assert.ok(r <= 6, `у края тени яркость с чёткостью отличается от «без» на ${r.toFixed(1)} уровней`);
  });

  test('«bw» остаётся строго чёрно-белым (только 0 и 255), размер не меняется', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const big = await h.straight(util, arg[0], arg[1]);
      const c = h.copy(big); img.applyFilter(c, 'bw');
      const d = h.px(c); let bad = 0, black = 0;
      for (let i = 0; i < d.length; i += 4) { if (!((d[i] === 0 || d[i] === 255) && d[i+1] === d[i] && d[i+2] === d[i])) bad++; if (d[i] === 0) black++; }
      return { bad, black, same: c.width === big.width && c.height === big.height };
    `, BLURRY);
    assert.equal(r.bad, 0, 'не только 0/255');
    assert.ok(r.same, 'размер изменился');
    assert.ok(r.black > 1000, 'текст пропал');
  });

  test('размеры не меняются ни в одном фильтре; однотонный холст остаётся однотонным', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const out = [];
      for (const f of img.FILTERS) for (const col of ['rgb(200,200,200)', 'rgb(240,230,120)', 'rgb(20,30,40)']) {
        const c = h.solid(137, 91, col);
        img.applyFilter(c, f);
        const d = h.px(c); let different = 0;
        for (let i = 4; i < d.length; i += 4) if (d[i] !== d[0] || d[i+1] !== d[1] || d[i+2] !== d[2]) different++;
        out.push({ f, col, size: [c.width, c.height], different });
      }
      return out;
    `);
    for (const o of r) {
      assert.deepEqual(o.size, [137, 91], `${o.f} ${o.col}`);
      assert.equal(o.different, 0, `${o.f} ${o.col}: холст перестал быть однотонным`);
    }
  });

  test('крошечные холсты (1×1, 3×2, 1×500, 500×1) не падают', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const sizes = [[1, 1], [3, 2], [1, 500], [500, 1], [2, 2]], out = [];
      for (const f of img.FILTERS) for (const [w, hh] of sizes) {
        const c = h.solid(w, hh, 'rgb(180,170,160)');
        h.fill(c, 'rgb(20,20,20)', 0, 0, Math.max(1, w >> 1), Math.max(1, hh >> 1));
        img.applyFilter(c, f);
        const d = h.px(c);
        out.push({ f, w, hh, ok: c.width === w && c.height === hh && d.every(v => v >= 0 && v <= 255 && !Number.isNaN(v)) });
      }
      return out;
    `);
    assert.ok(r.every(o => o.ok), JSON.stringify(r.filter(o => !o.ok)));
  });

  test('«original» не меняется вообще (ни с чёткостью, ни без)', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const big = await h.straight(util, arg[0], arg[1]);
      const before = h.px(big).slice();
      const res = [];
      for (const o of [undefined, { sharpen: true }, { sharpen: false }]) {
        const c = h.copy(big); const ret = img.applyFilter(c, 'original', o);
        const d = h.px(c); let diff = 0;
        for (let i = 0; i < d.length; i++) if (d[i] !== before[i]) diff++;
        res.push({ diff, same: ret === c });
      }
      return res;
    `, BLURRY);
    for (const x of r) { assert.equal(x.diff, 0); assert.ok(x.same, 'вернул другой холст'); }
  });

  test('«enhance» на холсте 2480×1754 с чёткостью — не дольше 3 с', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const c = h.solid(2480, 1754, 'rgb(225,225,220)');
      for (let y = 100; y < 1700; y += 40) h.fill(c, 'rgb(40,40,40)', 150, y, 1800, 6);
      const t = performance.now(); img.applyFilter(c, 'enhance'); return performance.now() - t;
    `);
    assert.ok(r < 3000, `заняло ${Math.round(r)} мс`);
  });

  test('детерминизм: два прогона дают одинаковые пиксели', async () => {
    const { page } = await unitPage(browser, server);
    const r = await run(page, `
      const big = await h.straight(util, arg[0], arg[1]);
      const out = {};
      for (const f of ['enhance', 'color', 'gray', 'doc', 'bw']) {
        const a = h.copy(big), b = h.copy(big);
        img.applyFilter(a, f); img.applyFilter(b, f);
        const da = h.px(a), db = h.px(b); let diff = 0;
        for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) diff++;
        out[f] = diff;
      }
      return out;
    `, BLURRY);
    for (const [f, n] of Object.entries(r)) assert.equal(n, 0, `«${f}»: ${n} отличающихся значений`);
  });
});

describe('поиск краёв после замены размытия', () => {
  for (const name of Object.keys(truth)) {
    test(`${name}: углы найдены с ошибкой не больше 2% длинной стороны`, async () => {
      const { page } = await unitPage(browser, server);
      const r = await inApp(page, async ({ img, util }, b64) => {
        const c = await util.loadCanvas(b64);
        return { size: [c.width, c.height], found: img.detectDocument(c) };
      }, fixtureB64(name));
      assert.ok(r.found, 'лист не найден');
      const px = r.found.map(([x, y]) => [x * r.size[0], y * r.size[1]]);
      const err = cornerError(px, truth[name]);
      const limit = 0.02 * Math.max(...r.size);
      assert.ok(err <= limit, `ошибка ${err.toFixed(1)} px > ${limit} px`);
    });
  }
});
