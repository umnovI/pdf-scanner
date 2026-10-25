// Поиск краёв листа (detectDocument): фото из truth.json, регрессии, краевые случаи, инварианты.
// Старый код для проверки регрессий: APP_COMMIT=d7f1e26 (main) или APP_COMMIT=f54342a (первая версия исправления).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { cornerError, fixtureB64, inApp, launch, startServer, truth, unitPage } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

// ---------- Рисование сцен в браузере ----------
// Библиотека передаётся в страницу текстом: lib(img) → { scene }.
function lib(img) {
  // Детерминированный генератор случайных чисел.
  const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const path = (x, q) => { x.beginPath(); q.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.closePath(); };
  /**
   * Сцена: стол (bg, texture: { kind: 'stripes' | 'checks', color }), листы-четырёхугольники
   * (sheets или corners, в пикселях) со строками текста, тень (shadow — сдвиг в px), шум (noise).
   */
  function scene({ W, H, bg = '#3a3a3a', paper = '#f2f0ea', corners, sheets, texture, text = true, shadow = 0, noise = 0 }) {
    const c = img.makeCanvas(W, H);
    const x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    if (texture) {
      const s = Math.round(Math.min(W, H) / 14);
      x.fillStyle = texture.color;
      if (texture.kind === 'stripes') for (let px = 0; px < W; px += s * 2) x.fillRect(px, 0, s, H);
      else for (let py = 0; py < H; py += s) for (let px = 0; px < W; px += s) if (((px / s) + (py / s)) % 2) x.fillRect(px, py, s, s);
    }
    for (const q of (sheets || [corners])) {
      if (shadow) {
        x.save(); x.filter = `blur(${Math.round(W / 60)}px)`;
        path(x, q.map(([px, py]) => [px + shadow, py + shadow])); x.fillStyle = 'rgba(0,0,0,0.55)'; x.fill();
        x.restore();
      }
      path(x, q); x.fillStyle = paper; x.fill();
      if (text) {
        x.save();
        path(x, q); x.clip();
        const xs = q.map(p => p[0]), ys = q.map(p => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        x.fillStyle = '#555';
        const step = (y1 - y0) / 24;
        for (let py = y0 + step * 3; py < y1 - step * 2; py += step) x.fillRect(x0 + (x1 - x0) * 0.15, py, (x1 - x0) * 0.7, Math.max(2, step * 0.25));
        x.restore();
      }
    }
    if (noise) {
      const id = x.getImageData(0, 0, W, H), d = id.data, r = rng(7);
      for (let i = 0; i < d.length; i += 4) {
        const g = (r() + r() + r() - 1.5) * 2 * noise;
        d[i] += g; d[i + 1] += g; d[i + 2] += g;
      }
      x.putImageData(id, 0, 0);
    }
    return c;
  }
  return { scene };
}
const LIB = lib.toString();

/** Выполняет fn({ img, util, S }, arg) в браузере, где S = lib(img). */
async function run(fn, arg) {
  const { page } = await unitPage(browser, server);
  return inApp(page, ({ img, util }, a) => {
    const S = (0, eval)('(' + a.lib + ')')(img);
    // eslint-disable-next-line no-new-func
    return (new Function('return ' + a.fn))()({ img, util, S }, a.arg);
  }, { lib: LIB, fn: fn.toString(), arg });
}

// ---------- Проверки в Node ----------
const rect = (W, H, [x0, y0, x1, y1]) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [x * W, y * H]);
const toPx = (found, W, H) => found.map(([x, y]) => [x * W, y * H]);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
const area = q => Math.abs(q.reduce((s, p, i) => s + p[0] * q[(i + 1) % 4][1] - q[(i + 1) % 4][0] * p[1], 0)) / 2;

/** Инварианты результата: 4 точки в долях [0,1], TL,TR,BR,BL по часовой на экране, выпуклость, площадь ≥ 8%. */
function checkInvariants(found, label = '') {
  const m = `${label} ${JSON.stringify(found)}`;
  assert.ok(Array.isArray(found) && found.length === 4, `нужно 4 точки: ${m}`);
  for (const p of found) {
    assert.equal(p.length, 2, m);
    for (const v of p) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `точка вне [0,1]: ${m}`);
  }
  const signs = found.map((_, i) => cross(found[i], found[(i + 1) % 4], found[(i + 2) % 4]));
  assert.ok(signs.every(s => s > 0), `не выпуклый или не по часовой стрелке на экране: ${m}`);
  const [tl, tr, br, bl] = found;
  assert.ok(tl[0] + tl[1] <= Math.min(tr[0] + tr[1], bl[0] + bl[1]) && br[0] + br[1] >= Math.max(tr[0] + tr[1], bl[0] + bl[1]), `порядок TL,TR,BR,BL: ${m}`);
  assert.ok(area(found) >= 0.08, `площадь меньше 8%: ${m}`);
}

/** Ошибка углов в пикселях кадра W×H не больше доли длинной стороны. */
function checkCorners(found, expectedPx, W, H, frac, label = '') {
  assert.ok(found, `${label}: лист не найден`);
  checkInvariants(found, label);
  const err = cornerError(toPx(found, W, H), expectedPx);
  const limit = frac * Math.max(W, H);
  assert.ok(err <= limit, `${label}: ошибка угла ${err.toFixed(1)} px больше допустимых ${limit.toFixed(1)} px (${JSON.stringify(toPx(found, W, H).map(p => p.map(Math.round)))})`);
}

const detectScene = opts => run(({ img, S }, o) => img.detectDocument(S.scene(o)), opts);
const detectFixture = name => run(async ({ img, util }, b64) => {
  const c = await util.loadCanvas(b64);
  return { size: [c.width, c.height], found: img.detectDocument(c) };
}, fixtureB64(name));

// ---------- Тестовые фото ----------
describe('фото из truth.json: ошибка углов не больше 1,5% длинной стороны', () => {
  for (const name of Object.keys(truth)) {
    const opts = name === 'lowcontrast.jpg'
      ? { todo: 'известное ограничение: белый лист на светло-сером столе с сильной тенью и на листе не находится (и в main)' }
      : {};
    test(name, opts, async () => {
      const r = await detectFixture(name);
      checkCorners(r.found, truth[name], r.size[0], r.size[1], 0.015, name);
    });
  }

  // Регрессии. На main ornate.jpg даёт ошибку ~15% (около 190 px); на первой версии исправления
  // (f54342a) castshadow.jpg даёт 69 px, rot45.jpg — 10 px вместо 6.
  test('регрессия: грамота с широкой тёмной узорной рамкой — рамка по краю листа, а не по светлой середине', async () => {
    const r = await detectFixture('ornate.jpg');
    assert.ok(r.found, 'лист не найден');
    const err = cornerError(toPx(r.found, 1000, 1250), truth['ornate.jpg']);
    assert.ok(err <= 25, `ошибка ${err.toFixed(1)} px`);
  });

  test('регрессия: тёмная тень на столе вплотную к листу не попадает в рамку (было 69 px)', async () => {
    const r = await detectFixture('castshadow.jpg');
    assert.ok(r.found, 'лист не найден');
    const err = cornerError(toPx(r.found, 1000, 1250), truth['castshadow.jpg']);
    assert.ok(err <= 25, `ошибка ${err.toFixed(1)} px`);
  });

  test('регрессия: лист, повёрнутый на 45°, находится точнее 8 px (в первой версии исправления 10 px)', async () => {
    const r = await detectFixture('rot45.jpg');
    assert.ok(r.found, 'лист не найден');
    const err = cornerError(toPx(r.found, 1000, 1250), truth['rot45.jpg']);
    assert.ok(err <= 8, `ошибка ${err.toFixed(1)} px`);
  });
});

// ---------- Повороты кадра ----------
describe('разная ориентация: рамка поворачивается вместе с фото', () => {
  for (const name of ['white.jpg', 'ornate.jpg', 'rot45.jpg']) {
    test(`${name}: повороты 0/90/180/270`, async () => {
      const exp = truth[name].map(([x, y]) => [x / 1000, y / 1250]);
      const r = await run(async ({ img, util }, a) => {
        const base = await util.loadCanvas(a.b64);
        return [[0, 0, 1], [90, 1, 1], [180, 2, 1], [270, 1, -1]].map(([deg, times, dir]) => {
          const c = img.rotateCanvas(base, deg);
          let e = a.exp;
          for (let i = 0; i < times; i++) e = img.rotateCorners(e, dir);
          return { deg, size: [c.width, c.height], found: img.detectDocument(c), exp: e };
        });
      }, { b64: fixtureB64(name), exp });
      for (const { deg, size, found, exp: e } of r) {
        checkCorners(found, e.map(([x, y]) => [x * size[0], y * size[1]]), size[0], size[1], 0.015, `${name} ${deg}°`);
      }
    });
  }
});

// ---------- Краевые случаи ----------
describe('краевые случаи', () => {
  test('однотонный кадр — листа нет (null); кадр из одного шума — null или допустимая рамка', async () => {
    const r = await run(({ img, S }) => {
      const any = [[0, 0], [1, 0], [1, 1], [0, 1]];
      return {
        flat: img.detectDocument(S.scene({ W: 800, H: 600, bg: '#777', paper: '#777', text: false, corners: any })),
        noisy: img.detectDocument(S.scene({ W: 800, H: 600, bg: '#777', paper: '#777', text: false, noise: 25, corners: any })),
      };
    });
    assert.equal(r.flat, null);
    if (r.noisy !== null) checkInvariants(r.noisy, 'шум');
  });

  test('лист во весь кадр (касается всех краёв): null или рамка ≈ весь кадр', async () => {
    const W = 800, H = 1000;
    const q = [[0, 0], [W, 0], [W, H], [0, H]];
    const found = await detectScene({ W, H, bg: '#202020', corners: q });
    if (found !== null) checkCorners(found, q, W, H, 0.03, 'во весь кадр');
  });

  test('лист с узкими полями 2% по краям кадра: null или правильная рамка', async () => {
    const W = 800, H = 1000;
    const q = rect(W, H, [0.02, 0.02, 0.98, 0.98]);
    const found = await detectScene({ W, H, corners: q });
    if (found !== null) checkCorners(found, q, W, H, 0.03, 'поля 2%');
  });

  test('два листа рядом: рамка вокруг одного из них целиком, не захватывает оба и не половину', async () => {
    const W = 1600, H = 1000;
    const a = rect(W, H, [0.06, 0.12, 0.47, 0.88]), b = rect(W, H, [0.53, 0.12, 0.94, 0.88]);
    const found = await detectScene({ W, H, sheets: [a, b] });
    assert.ok(found, 'ничего не найдено');
    checkInvariants(found, 'два листа');
    const px = toPx(found, W, H);
    const ea = cornerError(px, a), eb = cornerError(px, b);
    assert.ok(Math.min(ea, eb) <= 0.03 * W, `рамка не совпала ни с одним листом: ошибки ${ea.toFixed(0)} и ${eb.toFixed(0)} px, ${JSON.stringify(px.map(p => p.map(Math.round)))}`);
  });

  test('лист касается верхнего края кадра', async () => {
    const W = 800, H = 1000;
    const q = [[150, 0], [650, 0], [660, 800], [140, 810]];
    checkCorners(await detectScene({ W, H, corners: q }), q, W, H, 0.03, 'у верхнего края');
  });

  test('лист касается левого края кадра', async () => {
    const W = 800, H = 1000;
    const q = [[0, 150], [560, 140], [570, 850], [0, 860]];
    checkCorners(await detectScene({ W, H, corners: q }), q, W, H, 0.03, 'у левого края');
  });

  test('очень маленький лист (5% кадра): null или правильная рамка', async () => {
    const W = 1000, H = 1000;
    const s = Math.sqrt(0.05);
    const q = rect(W, H, [0.5 - s / 2, 0.5 - s / 2, 0.5 + s / 2, 0.5 + s / 2]);
    const found = await detectScene({ W, H, corners: q });
    if (found !== null) checkCorners(found, q, W, H, 0.03, 'маленький лист');
  });

  test('небольшой лист (12% кадра) находится', async () => {
    const W = 1000, H = 1000;
    const q = rect(W, H, [0.33, 0.33, 0.67, 0.67]);
    checkCorners(await detectScene({ W, H, corners: q }), q, W, H, 0.02, '12%');
  });

  test('очень вытянутый кадр: панорама 3000×600', async () => {
    const W = 3000, H = 600;
    const q = [[1100, 80], [1900, 70], [1910, 540], [1090, 530]];
    checkCorners(await detectScene({ W, H, corners: q }), q, W, H, 0.015, 'панорама');
  });

  test('очень вытянутый кадр: высокий 600×3000', async () => {
    const W = 600, H = 3000;
    const q = [[80, 900], [520, 880], [530, 2100], [90, 2110]];
    checkCorners(await detectScene({ W, H, corners: q }), q, W, H, 0.015, 'высокий');
  });

  test('тёмный лист на светлом столе', async () => {
    const W = 800, H = 1000;
    const q = [[150, 120], [660, 150], [640, 880], [130, 850]];
    checkCorners(await detectScene({ W, H, bg: '#e4e0d2', paper: '#2c2e33', corners: q }), q, W, H, 0.02, 'тёмный лист');
  });

  // Известное ограничение: если светлые клетки стола заметно ярче остального стола, а край листа
  // проходит рядом с клеткой, рамка «прилипает» к клетке (ошибка угла 38-42 px при допуске 33 px).
  const sticky = c => ({ todo: `известное ограничение: светлые клетки стола ${c} слипаются с листом, рамка уходит на клетку (~40 px)` });
  for (const [kind, name, color, bg, opts] of [
    ['stripes', 'полосы', '#7a5a3a', '#4a3524', {}],
    ['checks', 'клетка', '#808080', '#6a6a6a', {}],
    ['checks', 'яркая клетка', '#a8a8a8', '#6a6a6a', sticky('#a8a8a8')],
    ['checks', 'очень яркая клетка', '#c9c9c9', '#6a6a6a', sticky('#c9c9c9')],
  ]) {
    test(`лист на столе с крупной фактурой: ${name}`, opts, async () => {
      const W = 900, H = 1100;
      const q = [[170, 140], [740, 170], [720, 960], [150, 930]];
      checkCorners(await detectScene({ W, H, bg, texture: { kind, color }, corners: q }), q, W, H, 0.03, kind);
    });
  }

  test('шум на кадре: лист находится', async () => {
    const W = 800, H = 1000;
    const q = [[150, 120], [660, 150], [640, 880], [130, 850]];
    checkCorners(await detectScene({ W, H, noise: 18, corners: q }), q, W, H, 0.02, 'шум');
  });

  test('лист с тенью на столе справа-снизу', async () => {
    const W = 800, H = 1000;
    const q = [[150, 120], [660, 150], [640, 880], [130, 850]];
    checkCorners(await detectScene({ W, H, bg: '#8a8a86', shadow: 30, corners: q }), q, W, H, 0.03, 'тень');
  });
});

// ---------- Инварианты ----------
describe('инварианты результата', () => {
  test('на всех фото (кроме lowcontrast): 4 точки в [0,1], порядок TL,TR,BR,BL, выпуклость, площадь ≥ 8%', async () => {
    const files = Object.keys(truth).filter(n => n !== 'lowcontrast.jpg');
    const all = await run(async ({ img, util }, list) => {
      const out = {};
      for (const [name, b64] of list) out[name] = img.detectDocument(await util.loadCanvas(b64));
      return out;
    }, files.map(n => [n, fixtureB64(n)]));
    for (const n of files) checkInvariants(all[n], n);
  });

  test('lowcontrast.jpg: результат либо null, либо корректная рамка', async () => {
    const { found } = await detectFixture('lowcontrast.jpg');
    if (found !== null) checkInvariants(found, 'lowcontrast');
  });
});

// ---------- Детерминизм и скорость ----------
describe('детерминизм и скорость', () => {
  test('один и тот же кадр — один и тот же результат (и на копии холста)', async () => {
    const r = await run(async ({ img, util }, b64) => {
      const c = await util.loadCanvas(b64);
      const copy = img.makeCanvas(c.width, c.height);
      copy.getContext('2d').drawImage(c, 0, 0);
      return [img.detectDocument(c), img.detectDocument(c), img.detectDocument(copy)];
    }, fixtureB64('ornate.jpg'));
    assert.deepEqual(r[1], r[0]);
    assert.deepEqual(r[2], r[0]);
  });

  test('кадр 3000×2250 обрабатывается не дольше 500 мс (медиана из трёх)', async () => {
    const q = [[600, 300], [2300, 360], [2250, 1950], [560, 1900]];
    const r = await run(({ img, S }, corners) => {
      const c = S.scene({ W: 3000, H: 2250, bg: '#2e3a30', texture: { kind: 'checks', color: '#38453a' }, noise: 8, corners });
      img.detectDocument(c); // прогрев
      const t = [];
      let found;
      for (let i = 0; i < 3; i++) { const t0 = performance.now(); found = img.detectDocument(c); t.push(performance.now() - t0); }
      return { t, found };
    }, q);
    const med = [...r.t].sort((a, b) => a - b)[1];
    assert.ok(med <= 500, `медиана ${med.toFixed(0)} мс (${r.t.map(Math.round)})`);
    checkCorners(r.found, q, 3000, 2250, 0.02, 'большой кадр');
  });
});
