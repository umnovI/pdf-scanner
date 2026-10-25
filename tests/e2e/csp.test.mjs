// CSP и офлайн-запуск по адресу с параметром.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addFromGallery, launch, makePdf, menuAct, openApp, openEditor, startServer, swIdle, swReady } from '../helpers.mjs';
import { fx, pdfInput } from '../pdfutil.mjs';

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

test('нарушений CSP нет: объединение PDF (файлы и проект, скачивание) и сжатие PDF', async () => {
  const { page, errors } = await openApp(browser, server, {
    init: [() => {
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', e =>
        window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    }],
  });
  await addFromGallery(page, ['white.jpg']);
  await menuAct(page, 'merge');
  await page.selectOption('#merge-project', { index: 1 });
  await page.setInputFiles('#in-merge', [pdfInput('text')]);
  await page.waitForSelector('#busy[hidden]', { state: 'attached' });
  await page.click('#merge-make');
  await page.waitForSelector('#merge-download:not([hidden])');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#merge-download')]);
  assert.match(dl.suggestedFilename(), /\.pdf$/);
  await page.click('#merge-close');

  await menuAct(page, 'compress');
  await page.setInputFiles('#in-compress', pdfInput('text'));
  await page.selectOption('#compress-target', '1');
  await page.click('#compress-make');
  await page.waitForSelector('#compress-result:not([hidden])');
  await page.click('#compress-close');
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors, []);
});

test('офлайн: новые модули в кэше сервис-воркера, объединение и сжатие работают без сети', async () => {
  const { ctx, page, errors } = await openApp(browser, server);
  await swReady(page);
  await swIdle(page);
  const cached = await page.evaluate(async () => {
    const out = [];
    for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) out.push(new URL(r.url).pathname.split('/').pop());
    return out;
  });
  for (const f of ['pdfread.js', 'pdftools.js', 'app.js', 'pdf.js']) assert.ok(cached.includes(f), `${f} нет в кэше: ${cached}`);
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForSelector('#btn-camera', { state: 'visible' });
  await menuAct(page, 'merge');
  await page.setInputFiles('#in-merge', [pdfInput('text'), pdfInput('objstm')]);
  await page.waitForSelector('#busy[hidden]', { state: 'attached' });
  await page.click('#merge-make');
  await page.waitForSelector('#merge-download:not([hidden])');
  assert.match(await page.textContent('#merge-result'), /^Готово: 6 стр\./);
  await page.click('#merge-close');
  await menuAct(page, 'compress');
  await page.setInputFiles('#in-compress', pdfInput('images'));
  await page.selectOption('#compress-target', 'custom');
  await page.fill('#compress-custom', '0.3');
  await page.click('#compress-make');
  await page.waitForSelector('#compress-result:not([hidden])');
  await page.waitForSelector('#busy[hidden]', { state: 'attached', timeout: 30000 });
  assert.match(await page.textContent('#compress-result'), /^Готово: /);
  await ctx.setOffline(false);
  assert.deepEqual(errors, []);
});
