// Регрессионные тесты на ошибки обработки изображений и PDF, которые раньше находил только код-ревью.
// Проверка на старом коде:
//   APP_COMMIT=<коммит> node --test --test-name-pattern='регрессия N' tests/unit/regression.test.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PDF_SHAPES, buildPdfBytes, cornerError, fixtureB64, inApp, launch, paperColor, parsePdf, startServer, truth, unitPage } from '../helpers.mjs';

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
  const [r, g, b] = await paperColor(page, 'yellow.jpg', 'enhance');
  assert.ok(b < r - 60 && b < g - 60, `жёлтая бумага побелела: ${[r, g, b].map(Math.round)}`);
});

test('регрессия 7: страницы PDF одного размера для вертикального и горизонтального фото (ошибка в 2f15e33, исправлена в f441384)', async () => {
  const { page } = await unitPage(browser, server);
  // вертикальное, горизонтальное, узкое и другие — те же формы, что в pdf.test.mjs
  const buf = await buildPdfBytes(page, Object.values(PDF_SHAPES), { size: 'a4', fit: 'fit' });
  const parsed = parsePdf(buf);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.pages.length, Object.keys(PDF_SHAPES).length);
  const boxes = new Set(parsed.pages.map(p => p.join(' ')));
  assert.equal(boxes.size, 1, `страницы разного размера: ${[...boxes].join(' | ')}`);
});
