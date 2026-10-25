// CSP и офлайн-запуск по адресу с параметром.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addFromGallery, launch, makePdf, openApp, openEditor, startServer, swIdle, swReady } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

test('установленное приложение без сети открывается по адресу с параметром', async () => {
  const { ctx, page, errors } = await openApp(browser, server);
  await swReady(page);
  await swIdle(page);
  await ctx.setOffline(true);
  await page.goto(server.url + '?from=share');
  await page.waitForSelector('#btn-camera', { state: 'visible' });
  assert.match(page.url(), /\?from=share$/);
  await ctx.setOffline(false);
  assert.deepEqual(errors, []);
});

test('нарушений CSP нет: загрузка, добавление фото, редактор, PDF', async () => {
  const { page, errors } = await openApp(browser, server, {
    init: [() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', e =>
        window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    }],
  });
  await addFromGallery(page, ['white.jpg']);
  await openEditor(page, 1);
  await page.click('#ed-cancel');
  await makePdf(page);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors, []);
});
