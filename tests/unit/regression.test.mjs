// Регрессионные тесты на ошибки обработки изображений и PDF, которые раньше находил только код-ревью.
// Проверка на старом коде:
//   APP_COMMIT=<коммит> node --test --test-name-pattern='регрессия N' tests/unit/regression.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cornerError, fixtureB64, inApp, launch, parsePdf, startServer, truth, unitPage } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

test('регрессия 5: лист, повёрнутый на 45°, находится (ошибка в 7fd69fe, исправлена в ff3fe2c)', async () => {
  const { page } = await unitPage(browser, server);
  const r = await inApp(page, async ({ img, util }, b64) => {
    const c = await util.loadCanvas(b64);
    return { size: [c.width, c.height], found: img.detectDocument(c) };
  }, fixtureB64('rot45.jpg'));
  assert.ok(r.found, 'лист на 45° не найден');
  const err = cornerError(r.found.map(([x, y]) => [x * r.size[0], y * r.size[1]]), truth['rot45.jpg']);
  assert.ok(err <= 0.02 * r.size[1], `ошибка угла ${err.toFixed(1)} px`);
});

test('регрессия 6: «Улучшить» не отбеливает жёлтую грамоту (ошибка в f441384, исправлена в 7fd69fe)', async () => {
  const { page } = await unitPage(browser, server);
  const [r, g, b] = await inApp(page, async ({ img, util }, b64) => {
    const base = await util.loadCanvas(b64);
    const c = img.makeCanvas(base.width, base.height);
    c.getContext('2d').drawImage(base, 0, 0);
    img.applyFilter(c, 'enhance');
    const d = c.getContext('2d').getImageData(300, 400, 300, 300).data;
    let s = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
    return s.map(v => v / (d.length / 4));
  }, fixtureB64('yellow.jpg'));
  assert.ok(b < r - 60 && b < g - 60, `жёлтая бумага побелела: ${[r, g, b].map(Math.round)}`);
});

test('регрессия 7: страницы PDF одного размера для вертикального и горизонтального фото (ошибка в 2f15e33, исправлена в f441384)', async () => {
  const { page } = await unitPage(browser, server);
  const b64 = await inApp(page, async ({ pdf, util }) => {
    const jpegs = [await util.mkJpeg(300, 400), await util.mkJpeg(400, 300), await util.mkJpeg(50, 600)];
    return util.b64(await pdf.buildPdf(jpegs, { size: 'a4', fit: 'fit' }));
  });
  const parsed = parsePdf(Buffer.from(b64, 'base64'));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.pages.length, 3);
  const boxes = new Set(parsed.pages.map(p => p.join(' ')));
  assert.equal(boxes.size, 1, `страницы разного размера: ${[...boxes].join(' | ')}`);
});
