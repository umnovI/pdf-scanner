// Обновление версии через сервис-воркер: плашка «Обновить», офлайн-режим.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  addFromCamera, addFromGallery, addSigs, bannerVisible, checkUpdate, launch, makePdf, openApp, openEditor,
  pageSigs, startServer, swBarrier, swReady, versionText, waitBannerFlag, waitPages,
} from '../helpers.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

/** Каждый тест — свой сервер (публикация версий меняет файлы) и свой «телефон». */
async function scenario(fn, build = 'aaa1111', appOpts = {}) {
  const server = await startServer({ build });
  let app;
  try {
    app = await openApp(browser, server, appOpts);
    const dialogs = [];
    app.page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
    await fn({ server, dialogs, ...app });
  } finally {
    await app?.ctx.close().catch(() => {});
    await server.close();
  }
}

/** Ждёт, пока воркер версии v закончил установку: кэш pdf-scanner-<v> есть и в нём все файлы приложения. */
const waitCacheFilled = (page, v, files = 12) => page.waitForFunction(async ([name, n]) => {
  if (!(await caches.has(name))) return false;
  return (await (await caches.open(name)).keys()).length >= n;
}, [`pdf-scanner-${v}`, files]);

/** Выкладывает новую версию и заставляет браузер её заметить. */
async function releaseNew(server, page, v = 'bbb2222') {
  server.publish(v);
  await checkUpdate(page);
}

describe('плашка «Обновить»', () => {
  test('при первой установке плашки нет', () => scenario(async ({ page, errors }) => {
    await swReady(page);
    await swBarrier(page);
    assert.equal(await bannerVisible(page), false);
    assert.equal(await versionText(page), 'Версия: aaa1111');
    assert.deepEqual(errors, []);
  }));

  test('после публикации новой версии плашка появляется', () => scenario(async ({ server, page }) => {
    await swReady(page);
    await releaseNew(server, page);
    await page.waitForSelector('#update:not([hidden])');
    assert.equal(await bannerVisible(page), true);
    assert.match(await page.textContent('#update'), /Вышла новая версия/);
    assert.equal(await page.textContent('#update-btn'), 'Обновить');
  }));

  test('повторная проверка без новой версии плашку не показывает', () => scenario(async ({ page }) => {
    await swReady(page);
    await checkUpdate(page);
    await swBarrier(page);
    await checkUpdate(page);
    await swBarrier(page);
    assert.equal(await bannerVisible(page), false);
  }));

  test('плашка скрыта, пока открыт редактор, и появляется после его закрытия', () => scenario(async ({ server, page }) => {
    await addFromGallery(page, ['white.jpg']);
    await swReady(page);
    await openEditor(page, 1);
    await releaseNew(server, page);
    await waitBannerFlag(page); // приложение знает об обновлении…
    assert.equal(await bannerVisible(page), false, '…но не показывает плашку поверх редактора');
    await page.click('#ed-cancel');
    await page.waitForSelector('#update', { state: 'visible' });
  }));

  test('плашка скрыта, пока открыто окно PDF, и появляется после его закрытия', () => scenario(async ({ server, page }) => {
    await addFromGallery(page, ['white.jpg']);
    await swReady(page);
    await page.click('#btn-pdf');
    await releaseNew(server, page);
    await waitBannerFlag(page);
    assert.equal(await bannerVisible(page), false);
    await page.click('#pdf-close');
    await page.waitForSelector('#update', { state: 'visible' });
  }));

  test('«Обновить»: загружается новая версия, страницы на месте', () => scenario(async ({ server, page, dialogs, errors }) => {
    await addSigs(page, [0, 1, 2]);
    await swReady(page);
    assert.equal(await versionText(page), 'Версия: aaa1111');
    await releaseNew(server, page);
    await page.waitForSelector('#update', { state: 'visible' });
    await page.click('#update-btn');
    await page.waitForFunction(() => document.getElementById('version').textContent === 'Версия: bbb2222');
    await waitPages(page, 3);
    assert.deepEqual(await pageSigs(page), [0, 1, 2]);
    assert.deepEqual(dialogs, [], 'без несохранённых страниц вопросов быть не должно');
    await swBarrier(page);
    assert.equal(await bannerVisible(page), false, 'после обновления плашки нет');
    assert.deepEqual(errors, []);
  }));

  // «нет ложной плашки, если страница уже в новой версии» (регрессия 3) и «плашка не закрывает кнопки редактора»
  // (регрессия 4) — в regression.test.mjs.

  test('следующая версия снова вызывает плашку (aaa → bbb → ccc)', () => scenario(async ({ server, page }) => {
    await swReady(page);
    await releaseNew(server, page, 'bbb2222');
    await page.waitForSelector('#update', { state: 'visible' });
    await page.click('#update-btn');
    await page.waitForFunction(() => document.getElementById('version').textContent === 'Версия: bbb2222');
    await swReady(page);
    await releaseNew(server, page, 'ccc3333');
    await page.waitForSelector('#update', { state: 'visible' });
  }));
});

describe('офлайн', () => {
  test('без сети приложение открывается со своими страницами и собирает PDF', () => scenario(async ({ ctx, page }) => {
    await addSigs(page, [0, 1]);
    await swReady(page);
    await waitCacheFilled(page, 'aaa1111'); // воркер закончил установку: кэш заполнен
    await ctx.setOffline(true);
    // проверка, что сеть действительно отключена и для воркера: незакэшированный адрес недоступен
    const reachable = await page.evaluate(() => fetch('/нет-такого-файла-' + Date.now()).then(() => true, () => false));
    assert.equal(reachable, false, 'офлайн-режим браузера должен действовать');

    await page.reload();
    await waitPages(page, 2);
    assert.deepEqual(await pageSigs(page), [0, 1]);
    assert.equal(await versionText(page), 'Версия: aaa1111');
    const { buf } = await makePdf(page);
    assert.ok(buf.length > 1000);
    await ctx.setOffline(false);
  }, 'aaa1111', {
    // ожидаемая ошибка консоли: намеренный запрос несуществующего адреса без сети
    allowErrors: [/^Failed to load resource: net::ERR_FAILED$/],
  }));

  test('офлайн: камера и редактор работают', () => scenario(async ({ ctx, page }) => {
    await swReady(page);
    await waitCacheFilled(page, 'aaa1111');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('#btn-camera');
    await addFromCamera(page, 'white.jpg');
    await page.click('#ed-done');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    await waitPages(page, 1);
    await ctx.setOffline(false);
  }));
});
