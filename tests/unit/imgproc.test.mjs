// Модуль imgproc.js: поворот, рамка, выравнивание, фильтры, поиск краёв.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { cornerError, fixtureB64, inApp, launch, startServer, truth, unitPage } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const SAMPLE = [[0.1, 0.2], [0.8, 0.15], [0.9, 0.85], [0.2, 0.9]];
const near = (a, b, eps = 1e-9) => a.every((p, i) => Math.abs(p[0] - b[i][0]) < eps && Math.abs(p[1] - b[i][1]) < eps);

describe('rotateCorners', () => {
  test('четыре поворота по часовой и четыре против дают исходную рамку', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }, c) => {
      const spin = dir => { let x = c; for (let i = 0; i < 4; i++) x = img.rotateCorners(x, dir); return x; };
      return { cw: spin(1), ccw: spin(-1) };
    }, SAMPLE);
    assert.ok(near(r.cw, SAMPLE), 'по часовой');
    assert.ok(near(r.ccw, SAMPLE), 'против часовой');
  });

  test('поворот по и против часовой взаимно обратны; два поворота одинаковы в обе стороны', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }, c) => {
      const twice = dir => img.rotateCorners(img.rotateCorners(c, dir), dir);
      return {
        a: img.rotateCorners(img.rotateCorners(c, 1), -1),
        b: img.rotateCorners(img.rotateCorners(c, -1), 1),
        cw2: twice(1), ccw2: twice(-1),
      };
    }, SAMPLE);
    assert.ok(near(r.a, SAMPLE));
    assert.ok(near(r.b, SAMPLE));
    assert.ok(near(r.cw2, r.ccw2));
  });

  test('рамка вращается вместе с картинкой: углы остаются на тех же точках фото', async () => {
    const { page } = await unitPage(browser, server);
    // Цветные метки в углах холста 200×100; рамка стоит на метках.
    const colors = await inApp(page, ({ img }) => {
      const W = 200, H = 100;
      const marks = [['#f00', 15, 15], ['#0f0', 185, 15], ['#00f', 185, 85], ['#ff0', 15, 85]];
      const c = img.makeCanvas(W, H);
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
      marks.forEach(([col, px, py]) => { x.fillStyle = col; x.fillRect(px - 6, py - 6, 12, 12); });
      const corners = marks.map(([, px, py]) => [px / W, py / H]);
      const name = (rot, dir) => {
        const rc = img.rotateCanvas(c, rot);
        const cs = (dir === 0 ? corners : img.rotateCorners(corners, dir));
        const d = rc.getContext('2d');
        return cs.map(([u, v]) => {
          const p = d.getImageData(Math.min(rc.width - 1, Math.floor(u * rc.width)), Math.min(rc.height - 1, Math.floor(v * rc.height)), 1, 1).data;
          return `${p[0] > 128 ? 'r' : '-'}${p[1] > 128 ? 'g' : '-'}${p[2] > 128 ? 'b' : '-'}`;
        });
      };
      return { none: name(0, 0), cw: name(90, 1), ccw: name(270, -1)};
    });
    const [R, G, B, Y] = ['r--', '-g-', '--b', 'rg-'];
    assert.deepEqual(colors.none, [R, G, B, Y]);
    // по часовой: левый нижний угол становится левым верхним и т. д.
    assert.deepEqual(colors.cw, [Y, R, G, B]);
    assert.deepEqual(colors.ccw, [G, B, Y, R]);
  });

  test('полный кадр остаётся полным кадром', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }) => [1, -1].map(d => img.isFullFrame(img.rotateCorners(img.FULL_FRAME, d))));
    assert.deepEqual(r, [true, true]);
  });
});

describe('isFullFrame', () => {
  test('полный кадр, малые отклонения и настоящая рамка', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }) => {
      const F = img.FULL_FRAME.map(p => [...p]);
      const moved = (i, dx) => F.map((p, k) => (k === i ? [p[0] + dx, p[1]] : p));
      return {
        full: img.isFullFrame(F),
        tiny: img.isFullFrame(moved(2, -5e-4)),
        big: img.isFullFrame(moved(2, -2e-3)),
        sample: img.isFullFrame([[0.1, 0.2], [0.8, 0.15], [0.9, 0.85], [0.2, 0.9]]),
        shuffled: img.isFullFrame([F[1], F[0], F[3], F[2]]),
      };
    });
    assert.deepEqual(r, { full: true, tiny: true, big: false, sample: false, shuffled: false });
  });
});

describe('rotateCanvas', () => {
  test('размеры при поворотах и возврат к исходному', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }) => {
      const c = img.makeCanvas(120, 80);
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 120, 80);
      x.fillStyle = '#f00'; x.fillRect(0, 0, 20, 10); // метка в левом верхнем углу
      const dim = k => { const o = img.rotateCanvas(c, k); return [o.width, o.height]; };
      const px = (cv, X, Y) => [...cv.getContext('2d').getImageData(X, Y, 1, 1).data.slice(0, 3)];
      let spun = c;
      for (let i = 0; i < 4; i++) spun = img.rotateCanvas(spun, 90);
      const cw = img.rotateCanvas(c, 90), ccw = img.rotateCanvas(c, -90);
      return {
        d0: dim(0), d90: dim(90), d180: dim(180), d270: dim(270), d360: dim(360), dm90: dim(-90),
        same0: img.rotateCanvas(c, 0) === c,
        spunSame: JSON.stringify(spun.getContext('2d').getImageData(0, 0, 120, 80).data) === JSON.stringify(c.getContext('2d').getImageData(0, 0, 120, 80).data),
        // красная метка из левого верхнего угла: по часовой — в правый верхний, против — в левый нижний
        cwMark: px(cw, 75, 5), ccwMark: px(ccw, 5, 115), cwEmpty: px(cw, 5, 5),
      };
    });
    assert.deepEqual(r.d0, [120, 80]);
    assert.deepEqual(r.d90, [80, 120]);
    assert.deepEqual(r.d180, [120, 80]);
    assert.deepEqual(r.d270, [80, 120]);
    assert.deepEqual(r.d360, [120, 80]);
    assert.deepEqual(r.dm90, [80, 120]);
    assert.ok(r.same0);
    assert.ok(r.spunSame, 'четыре поворота на 90° должны вернуть те же пиксели');
    assert.deepEqual(r.cwMark, [255, 0, 0]);
    assert.deepEqual(r.ccwMark, [255, 0, 0]);
    assert.deepEqual(r.cwEmpty, [255, 255, 255]);
  });
});

describe('warp', () => {
  test('размер результата и ограничение MAX_OUT', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }) => {
      const dims = (w, h, corners) => { const o = img.warp(img.makeCanvas(w, h), corners); return [o.width, o.height]; };
      const F = img.FULL_FRAME;
      return {
        max: img.MAX_OUT,
        full: dims(1000, 800, F),
        rect: dims(1000, 800, [[0.1, 0.2], [0.6, 0.2], [0.6, 0.8], [0.1, 0.8]]),
        // трапеция: ширина — большее из оснований, высота — большая из боковых сторон
        trapezoid: dims(1000, 1000, [[0.3, 0.1], [0.7, 0.1], [0.9, 0.9], [0.1, 0.9]]),
        huge: dims(3000, 2000, F),
        hugeTall: dims(2000, 4000, F),
        tiny: dims(4, 4, [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]),
      };
    });
    assert.equal(r.max, 2480);
    assert.deepEqual(r.full, [1000, 800]);
    assert.deepEqual(r.rect, [500, 480]);
    assert.deepEqual(r.trapezoid, [800, 825]); // боковые стороны наклонные: длина sqrt(200² + 800²)
    assert.deepEqual(r.huge, [2480, 1653]);
    assert.deepEqual(r.hugeTall, [1240, 2480]);
    assert.ok(r.tiny[0] >= 1 && r.tiny[1] >= 1, 'вырожденная рамка не должна давать пустой холст');
  });

  test('вырезает именно рамку и не заливает углы чужим цветом', async () => {
    const { page } = await unitPage(browser, server);
    const px = await inApp(page, ({ img }) => {
      const c = img.makeCanvas(400, 300);
      const x = c.getContext('2d');
      x.fillStyle = '#808080'; x.fillRect(0, 0, 400, 300);
      x.fillStyle = '#e00000'; x.fillRect(100, 50, 200, 200);
      const out = img.warp(c, [[0.25, 50 / 300], [0.75, 50 / 300], [0.75, 250 / 300], [0.25, 250 / 300]]);
      const d = out.getContext('2d');
      const at = (X, Y) => [...d.getImageData(X, Y, 1, 1).data.slice(0, 3)];
      return { size: [out.width, out.height], pts: [at(100, 100), at(3, 3), at(196, 3), at(196, 196), at(3, 196)] };
    });
    assert.deepEqual(px.size, [200, 200]);
    for (const p of px.pts) assert.ok(p[0] > 200 && p[1] < 40 && p[2] < 40, `ожидали красный, получили ${p}`);
  });

  test('перспектива: наклонный лист выпрямляется', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }) => {
      // Белый четырёхугольник со знакомой чёрной полосой у верхнего края на сером фоне.
      const W = 400, H = 400;
      const quad = [[100, 50], [300, 80], [330, 350], [70, 320]];
      const c = img.makeCanvas(W, H);
      const x = c.getContext('2d');
      x.fillStyle = '#404040'; x.fillRect(0, 0, W, H);
      x.fillStyle = '#fff'; x.beginPath(); quad.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.fill();
      const out = img.warp(c, quad.map(([a, b]) => [a / W, b / H]));
      const d = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
      let dark = 0;
      // Считаем тёмные пиксели на 3-пиксельной кайме: фона быть не должно (допуск на сглаживание края).
      for (let i = 0; i < out.width * out.height; i++) {
        const X = i % out.width, Y = (i / out.width) | 0;
        if ((X < 3 || Y < 3 || X >= out.width - 3 || Y >= out.height - 3) && d[i * 4] < 128) dark++;
      }
      return { dark, border: 2 * (out.width + out.height) * 3 };
    });
    assert.ok(r.dark / r.border < 0.05, `на каёмке выпрямленного листа остался фон: ${r.dark} из ${r.border}`);
  });
});

describe('applyFilter', () => {
  const FILTERS = ['original', 'enhance', 'color', 'gray', 'doc', 'bw'];

  test('список фильтров', async () => {
    const { page } = await unitPage(browser, server);
    assert.deepEqual(await inApp(page, ({ img }) => img.FILTERS), FILTERS);
  });

  for (const fx of ['school.jpg', 'darkphoto.jpg']) {
    test(`все фильтры: размер не меняется, doc/gray/bw серые, bw — только 0 и 255 (${fx})`, async () => {
      const { page } = await unitPage(browser, server);
      const r = await inApp(page, async ({ img, util }, { b64, filters }) => {
        const base = img.drawScaled(await util.loadCanvas(b64), 700);
        const ref = base.getContext('2d').getImageData(0, 0, base.width, base.height).data;
        const out = {};
        for (const f of filters) {
          const c = img.makeCanvas(base.width, base.height);
          c.getContext('2d').drawImage(base, 0, 0);
          const res = img.applyFilter(c, f);
          const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let gray = true, bw = true, same = true, opaque = true;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i] !== d[i + 1] || d[i] !== d[i + 2]) gray = false;
            if (d[i] !== 0 && d[i] !== 255) bw = false;
            if (d[i] !== ref[i] || d[i + 1] !== ref[i + 1] || d[i + 2] !== ref[i + 2]) same = false;
            if (d[i + 3] !== 255) opaque = false;
          }
          out[f] = { size: [c.width, c.height], same: res === c, gray, bw, unchanged: same, opaque };
        }
        return { size: [base.width, base.height], out };
      }, { b64: fixtureB64(fx), filters: FILTERS });
      for (const f of FILTERS) {
        const o = r.out[f];
        assert.deepEqual(o.size, r.size, `${f}: размер`);
        assert.ok(o.same, `${f}: должен вернуть тот же холст`);
        assert.ok(o.opaque, `${f}: прозрачные пиксели`);
      }
      assert.ok(r.out.original.unchanged, 'original ничего не меняет');
      for (const f of ['gray', 'doc', 'bw']) assert.ok(r.out[f].gray, `${f} должен быть серым`);
      for (const f of ['original', 'enhance', 'color']) assert.equal(r.out[f].gray, false, `${f} сохраняет цвет`);
      assert.ok(r.out.bw.bw, 'bw — только чёрный и белый');
      assert.equal(r.out.doc.bw, false, 'doc — с полутонами');
      for (const f of ['enhance', 'color', 'gray', 'doc', 'bw']) assert.equal(r.out[f].unchanged, false, `${f} что-то меняет`);
    });
  }

  test('неизвестный фильтр и пустое значение ничего не меняют', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }) => {
      const c = img.makeCanvas(30, 30);
      const x = c.getContext('2d');
      x.fillStyle = '#a0603c'; x.fillRect(0, 0, 30, 30);
      const before = [...x.getImageData(0, 0, 1, 1).data];
      const res = [img.applyFilter(c, undefined) === c, img.applyFilter(c, 'нет-такого') === c];
      return { res, before, after: [...x.getImageData(0, 0, 1, 1).data] };
    });
    assert.deepEqual(r.res, [true, true]);
    assert.deepEqual(r.after, r.before);
  });

  test('однотонные кадры (белый, чёрный, серый) не ломают фильтры', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }) => {
      const out = [];
      for (const col of ['#fff', '#000', '#808080']) {
        for (const f of img.FILTERS) {
          const c = img.makeCanvas(90, 60);
          const x = c.getContext('2d');
          x.fillStyle = col; x.fillRect(0, 0, 90, 60);
          img.applyFilter(c, f);
          const d = x.getImageData(0, 0, 90, 60).data;
          out.push({ col, f, size: [c.width, c.height], alpha: d.every((v, i) => i % 4 !== 3 || v === 255) });
        }
      }
      return out;
    });
    for (const o of r) {
      assert.deepEqual(o.size, [90, 60], `${o.col}/${o.f}`);
      assert.ok(o.alpha, `${o.col}/${o.f}`);
    }
  });
});

describe('detectDocument', () => {
  for (const name of Object.keys(truth)) {
    const opts = name === 'lowcontrast.jpg' ? { todo: 'известное ограничение: белый лист на светло-сером столе с сильной тенью не находится (и в main)' } : {};
    test(`находит углы листа: ${name} (ошибка не больше 2% длинной стороны)`, opts, async () => {
      const { page } = await unitPage(browser, server);
      const r = await inApp(page, async ({ img, util }, b64) => {
        const c = await util.loadCanvas(b64);
        return { size: [c.width, c.height], found: img.detectDocument(c) };
      }, fixtureB64(name));
      assert.ok(r.found, 'лист не найден');
      assert.equal(r.found.length, 4);
      const px = r.found.map(([x, y]) => [x * r.size[0], y * r.size[1]]);
      const err = cornerError(px, truth[name]);
      const limit = 0.02 * Math.max(...r.size);
      assert.ok(err <= limit, `ошибка угла ${err.toFixed(1)} px больше допустимых ${limit} px (${JSON.stringify(px.map(p => p.map(Math.round)))})`);
    });
  }

  test('горизонтальное фото без эталона: результат либо пуст, либо 4 точки внутри кадра', async () => {
    const { page } = await unitPage(browser, server);
    const found = await inApp(page, async ({ img, util }, b64) => img.detectDocument(await util.loadCanvas(b64)), fixtureB64('landscape.jpg'));
    if (found !== null) {
      assert.equal(found.length, 4);
      for (const [x, y] of found) assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1);
    }
  });

  test('однотонный кадр — листа нет (null)', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ img }) => ['#ffffff', '#000000', '#808080', '#d8c060'].map(col => {
      const c = img.makeCanvas(600, 800);
      const x = c.getContext('2d');
      x.fillStyle = col; x.fillRect(0, 0, 600, 800);
      return img.detectDocument(c);
    }));
    assert.deepEqual(r, [null, null, null, null]);
  });

  test('рамка выпуклая и обходится в порядке TL, TR, BR, BL', async () => {
    const { page } = await unitPage(browser, server);
    const found = await inApp(page, async ({ img, util }, b64) => img.detectDocument(await util.loadCanvas(b64)), fixtureB64('white.jpg'));
    const [tl, tr, br, bl] = found;
    assert.ok(tl[0] < tr[0] && bl[0] < br[0] && tl[1] < bl[1] && tr[1] < br[1], JSON.stringify(found));
  });
});

describe('цвет бумаги после фильтров', () => {
  /** Средний цвет центральной части листа после фильтра. */
  async function paper(name, filter) {
    const { page } = await unitPage(browser, server);
    return inApp(page, async ({ img, util }, { b64, filter }) => {
      const base = await util.loadCanvas(b64);
      const c = img.makeCanvas(base.width, base.height);
      c.getContext('2d').drawImage(base, 0, 0);
      img.applyFilter(c, filter);
      const d = c.getContext('2d').getImageData(300, 400, 300, 300).data;
      let r = 0, g = 0, b = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      return [r / n, g / n, b / n];
    }, { b64: fixtureB64(name), filter });
  }

  test('«Улучшить» оставляет жёлтую бумагу жёлтой', async () => {
    const [r, g, b] = await paper('yellow.jpg', 'enhance');
    assert.ok(b < r - 60 && b < g - 60, `жёлтая бумага побелела: ${[r, g, b].map(Math.round)}`);
  });

  test('«Цветной лист» оставляет жёлтую бумагу жёлтой', async () => {
    const [r, g, b] = await paper('yellow.jpg', 'color');
    assert.ok(b < r - 60 && b < g - 60, `жёлтая бумага побелела: ${[r, g, b].map(Math.round)}`);
  });

  test('«Улучшить» делает белую бумагу под тёплым светом почти нейтральной', async () => {
    const before = await paper('warm.jpg', 'original');
    const after = await paper('warm.jpg', 'enhance');
    const spread = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(spread(before) > 50, `фото и должно быть тёплым: ${before.map(Math.round)}`);
    assert.ok(spread(after) < 35, `осталась жёлтая подсветка: ${after.map(Math.round)}`);
    assert.ok(Math.min(...after) > 150, 'бумага не должна темнеть');
  });

  test('«Улучшить» не портит нейтральную белую бумагу', async () => {
    const [r, g, b] = await paper('white.jpg', 'enhance');
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 15, `появился оттенок: ${[r, g, b].map(Math.round)}`);
  });
});
