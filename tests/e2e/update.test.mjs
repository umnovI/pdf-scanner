// Обновление версии через сервис-воркер: плашка «Обновить», офлайн-режим.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  ROOT, appFromCommit, dbProjects,
  addFromCamera, addFromGallery, addSigs, bannerVisible, checkUpdate, launch, makePdf, openApp, openEditor,
  pageSigs, startServer, swBarrier, swIdle, swReady, versionText, waitBannerFlag, waitPages,
} from '../helpers.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

/**
 * Каждый тест — свой сервер (публикация версий меняет файлы) и свой «телефон».
 * Опции: build — версия сборки; остальные (allowErrors, device…) уходят в openApp. Контекст закрывает afterEach из helpers.
 */
async function scenario(fn, { build = 'aaa1111', ...appOpts } = {}) {
  const server = await startServer({ build });
  try {
    const app = await openApp(browser, server, appOpts);
    const dialogs = [];
    app.page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
    await fn({ server, dialogs, ...app });
  } finally {
    await server.close();
  }
}

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
    await swIdle(page); // воркер установлен и активен, новых нет
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
  }, {
    // ожидаемая ошибка консоли: намеренный запрос несуществующего адреса без сети
    allowErrors: [/^Failed to load resource: net::ERR_FAILED$/],
  }));

  test('офлайн: камера и редактор работают', () => scenario(async ({ ctx, page }) => {
    await swReady(page);
    await swIdle(page);
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

describe('обновление со старой версии приложения (как у пользователя на телефоне)', () => {
  // Приложение из коммита d7f1e26 (база v1, порядок в поле order, плашка «Обновить» старого образца)
  // обновляется до текущей версии: плашка появляется, «Обновить» загружает новую версию, страницы на месте.
  test('d7f1e26 → текущая: плашка, «Обновить», страницы и порядок сохранены, перенесены в «Проект 1»', async () => {
    const oldApp = appFromCommit('d7f1e26'); // { dir, cleanup }
    const server = await startServer({ appDir: oldApp.dir, build: 'old1111' });
    oldApp.cleanup();
    try {
      const { page, errors } = await openApp(browser, server);
      await addSigs(page, [2, 0, 1]);
      await swReady(page);
      await page.reload(); // обычный запуск: вкладка под управлением воркера
      await waitPages(page, 3);
      await swReady(page);
      assert.equal(await versionText(page), 'Версия: old1111');
      assert.equal(await page.evaluate(() => document.getElementById('project-name')), null, 'это действительно старый интерфейс');

      // «Выкладываем» текущую версию приложения поверх старой.
      fs.cpSync(path.join(ROOT, 'app'), server.dir, { recursive: true });
      for (const f of ['sw.js', 'app.js']) {
        const p = path.join(server.dir, f);
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace("'__BUILD__'", "'new2222'"));
      }
      await checkUpdate(page);
      await page.waitForSelector('#update', { state: 'visible' });
      await page.click('#update-btn');
      await page.waitForFunction(() => document.getElementById('version')?.textContent === 'Версия: new2222');
      await waitPages(page, 3);
      assert.deepEqual(await pageSigs(page), [2, 0, 1]);
      assert.equal(await page.textContent('#project-name'), 'Проект 1');
      const db = await dbProjects(page);
      assert.equal(db.projects.length, 1);
      assert.equal(db.projects[0].ids.length, 3);
      assert.equal(db.pages.length, 3);
      assert.equal(await page.evaluate(() => window.raw.version()), 3);
      // после обновления плашки нет, приложение работает: новый проект, ещё одна страница
      await swBarrier(page);
      assert.equal(await bannerVisible(page), false);
      await addSigs(page, [3]);
      assert.deepEqual(await pageSigs(page), [2, 0, 1, 3]);
      assert.deepEqual(errors, []);
    } finally {
      await server.close();
    }
  });
});
