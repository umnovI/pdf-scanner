// Регрессионные тесты на ошибки, которые раньше находил только код-ревью (интерфейс).
// Каждый тест падает на коде до исправления. Проверка на старом коде:
//   APP_COMMIT=<коммит> node --test --test-name-pattern='регрессия N' tests/e2e/regression.test.mjs
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  addFromGallery, addSigs, bannerVisible, checkUpdate, editorDone, isClickable, launch, openApp, openEditor, pageSigs,
  startServer, swBarrier, swReady, waitPages,
} from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const move = (page, n, dir) => page.locator('.page').nth(n - 1).locator(dir === 'left' ? '.left' : '.right').click();
async function remove(page, n) {
  page.once('dialog', d => d.accept());
  await page.locator('.page').nth(n - 1).locator('.del').click();
}

describe('порядок страниц (ошибка в 60cfd53, исправлена в c385e36 и f85fcc3)', () => {
  test('регрессия 1: переместить, изменить фильтр страницы, перезагрузить — порядок сохраняется', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    await move(page, 1, 'right');                 // [1, 0, 2]
    assert.deepEqual(await pageSigs(page), [1, 0, 2]);
    await openEditor(page, 1);                    // правим перемещённую страницу
    await page.click('#ed-filters [data-f="gray"]');
    await editorDone(page);
    assert.deepEqual(await pageSigs(page), [1, 0, 2]);
    await page.reload();
    await waitPages(page, 3);
    assert.deepEqual(await pageSigs(page), [1, 0, 2]);
  });

  test('регрессия 1б: переместить, повернуть вторую страницу, перезагрузить', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    await move(page, 3, 'left');                  // [0, 2, 1]
    await openEditor(page, 3);
    await page.click('#ed-filters [data-f="doc"]');
    await editorDone(page);
    await openEditor(page, 2);
    await page.click('#ed-filters [data-f="bw"]');
    await editorDone(page);
    await page.reload();
    await waitPages(page, 3);
    assert.deepEqual(await pageSigs(page), [0, 2, 1]);
  });

  test('регрессия 2: удалить первые страницы, добавить новую, перезагрузить — новая в конце', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2, 3]);
    await remove(page, 1);
    await waitPages(page, 3);
    await remove(page, 1);
    await waitPages(page, 2);
    await addSigs(page, [4]);
    assert.deepEqual(await pageSigs(page), [2, 3, 4]);
    await page.reload();
    await waitPages(page, 3);
    assert.deepEqual(await pageSigs(page), [2, 3, 4]);
  });

  test('удалить первую, добавить новую, перезагрузить (3 страницы; на старом коде это проходит)', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    await remove(page, 1);
    await waitPages(page, 2);
    await addSigs(page, [3]);
    await page.reload();
    await waitPages(page, 3);
    assert.deepEqual(await pageSigs(page), [1, 2, 3]);
  });
});

describe('обновление версии', () => {
  test('регрессия 3: нет ложной плашки, когда страница уже загружена в новой версии (ошибка в 11758ad, исправлена в df1f4ca)', async () => {
    const srv = await startServer({ build: 'aaa1111' });
    try {
      const { page } = await openApp(browser, srv);
      await swReady(page);
      srv.publish('bbb2222');
      await page.reload();
      await page.waitForFunction(() => document.getElementById('version').textContent === 'Версия: bbb2222');
      await page.evaluate(() => { window.oldController = navigator.serviceWorker.controller; });
      await checkUpdate(page);
      await page.waitForFunction(() => navigator.serviceWorker.controller !== window.oldController);
      await swBarrier(page);
      assert.equal(await page.evaluate(() => document.getElementById('update').hidden), true, 'флаг плашки выставлен ошибочно');
      assert.equal(await bannerVisible(page), false);
    } finally { await srv.close(); }
  });

  test('регрессия 4: плашка «Обновить» не закрывает кнопки «Отмена» и «Готово» в редакторе (ошибка в 6afc5d8)', async () => {
    const srv = await startServer({ build: 'aaa1111' });
    try {
      const { page } = await openApp(browser, srv);
      await addFromGallery(page, ['white.jpg']);
      await swReady(page);
      await page.reload(); // вкладка, открытая уже под управлением воркера (так бывает при каждом обычном запуске)
      await waitPages(page, 1);
      await swReady(page);
      srv.publish('bbb2222');
      await checkUpdate(page);
      await page.waitForSelector('#update', { state: 'visible' });
      await openEditor(page, 1);
      assert.equal(await bannerVisible(page), false, 'поверх редактора плашки быть не должно');
      for (const sel of ['#ed-cancel', '#ed-done']) assert.ok(await isClickable(page, sel), `${sel} закрыта другим элементом`);
      await page.click('#ed-cancel');
      await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    } finally { await srv.close(); }
  });
});
