// Поиск краёв в приложении: грамота с широкой тёмной рамкой, снятая камерой.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addFromCamera, dbRecords, editorDone, launch, openApp, startServer, truth } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

/**
 * Центры ручек .handle в долях фото. Холст редактора занимает всю сцену, а фото вписано в него
 * с полями 22 px (как в layoutEditor), поэтому доли считаем от вписанного прямоугольника фото.
 */
const handles = (page, [pw, ph]) => page.evaluate(([pw, ph]) => {
  const c = document.getElementById('ed-canvas').getBoundingClientRect();
  const pad = 22;
  const k = Math.min((c.width - 2 * pad) / pw, (c.height - 2 * pad) / ph);
  const w = pw * k, h = ph * k, x0 = (c.width - w) / 2, y0 = (c.height - h) / 2;
  return {
    w, h,
    pts: [...document.querySelectorAll('.handle')].map(hd => {
      const b = hd.getBoundingClientRect();
      return [(b.x + b.width / 2 - c.x - x0) / w, (b.y + b.height / 2 - c.y - y0) / h];
    }),
  };
}, [pw, ph]);

describe('рамка по краю листа в редакторе', () => {
  for (const name of ['ornate.jpg', 'castshadow.jpg']) {
    test(`${name}: ручки стоят на углах листа (отклонение не больше 2% размера фото на экране)`, async () => {
      const { page, errors } = await openApp(browser, server);
      await addFromCamera(page, name);
      const { w, h, pts } = await handles(page, [1000, 1250]);
      assert.equal(pts.length, 4);
      const exp = truth[name].map(([x, y]) => [x / 1000, y / 1250]);
      const err = Math.max(...pts.map((p, i) => Math.hypot((p[0] - exp[i][0]) * w, (p[1] - exp[i][1]) * h)));
      assert.ok(err <= 0.02 * Math.max(w, h), `ручки ${JSON.stringify(pts.map(p => p.map(v => +v.toFixed(3))))}, ошибка ${err.toFixed(1)} px при фото ${w.toFixed(0)}×${h.toFixed(0)}`);

      // «Готово» сохраняет ту же рамку в базе
      await editorDone(page);
      await page.waitForFunction(async () => ((await window.raw.all('pages')) || []).length === 1);
      const [rec] = await dbRecords(page);
      const dbErr = Math.max(...rec.corners.map((p, i) => Math.hypot((p[0] - exp[i][0]) * 1000, (p[1] - exp[i][1]) * 1250)));
      assert.ok(dbErr <= 25, `в базе ошибка ${dbErr.toFixed(1)} px`);
      assert.deepEqual(errors, []);
    });
  }
});
