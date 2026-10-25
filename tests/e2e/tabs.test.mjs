// Две вкладки и сбои IndexedDB: подсказка про другие вкладки, обновление формата базы, несохранённые страницы.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  addFromGallery, addSigs, blankPage, checkUpdate, dbRecords, editorDone, idbFailInit, launch, openApp, openEditor,
  pageCount, pageSigs, phone, startServer, swReady, waitPages,
} from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

/** Нажимает кнопку и ждёт диалог подтверждения; отвечает accept/dismiss и возвращает его текст. */
async function clickConfirm(page, selector, accept = false) {
  let timer;
  const shown = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('подтверждение так и не появилось')), 15000);
    page.once('dialog', async d => {
      clearTimeout(timer);
      const message = d.message();
      await (accept ? d.accept() : d.dismiss());
      resolve(message);
    });
  });
  await page.click(selector);
  try { return await shown; } finally { clearTimeout(timer); }
}

/** Собирает тексты всех диалогов (и отклоняет их) — для проверки, что вопросов не было. */
function collectDialogs(page) {
  const messages = [];
  page.on('dialog', d => { messages.push(d.message()); d.dismiss(); });
  return messages;
}

/** «Новая версия приложения в другой вкладке» повышает версию базы до 3. */
async function upgradeDbElsewhere(ctx) {
  const other = await ctx.newPage();
  await blankPage(other, server);
  const v = await other.evaluate(async () => { const db = await window.raw.open(3, () => {}); const n = db.version; db.close(); return n; });
  assert.equal(v, 3);
  return other;
}

describe('две вкладки', () => {
  test('старая вкладка держит базу v1 → новая показывает подсказку «Закройте другие вкладки»', async () => {
    const { ctx, page: old } = await phone(browser);
    await blankPage(old, server);
    // «Старая вкладка» со старой версией приложения: база v1 открыта и не отпускается.
    await old.evaluate(async () => { window.keep = await window.raw.open(1, d => d.createObjectStore('pages', { keyPath: 'id' })); });

    const fresh = await ctx.newPage();
    const errors = [];
    fresh.on('pageerror', e => errors.push(e.message));
    await fresh.goto(server.url);
    await fresh.waitForFunction(() => /Закройте другие вкладки/.test(document.getElementById('toast').textContent) && !document.getElementById('toast').hidden);
    // приложение остаётся рабочим: страницы добавляются, хотя и не сохраняются
    await addFromGallery(fresh, ['white.jpg']);
    assert.equal(await pageCount(fresh), 1);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('без блокировки подсказки нет', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0]);
    assert.doesNotMatch(await page.textContent('#toast'), /Закройте другие вкладки/);
  });

  test('другая вкладка открыла базу новой версии → плашка «Обновить» и подтверждение с числом несохранённых страниц', async () => {
    const { ctx, page } = await openApp(browser, server);
    await addSigs(page, [0]);                   // эта страница сохранена
    await page.evaluate(() => { window.marker = 'эта же вкладка'; });
    await upgradeDbElsewhere(ctx);

    await page.waitForSelector('#update', { state: 'visible' });
    assert.match(await page.textContent('#toast'), /обновилось в другой вкладке/);

    // Дальше записи в эту базу невозможны: две новые страницы остаются только на экране.
    await addSigs(page, [1, 2]);
    assert.deepEqual(await pageSigs(page), [0, 1, 2]);
    const message = await clickConfirm(page, '#update-btn');
    assert.match(message, /Страниц, не сохранённых в браузере: 2\./);
    assert.match(message, /Обновить\?$/);
    assert.equal(await page.evaluate(() => window.marker), 'эта же вкладка', 'отказ в подтверждении не перезагружает страницу');
    assert.equal(await pageCount(page), 3);
    await ctx.close();
  });

  test('согласие в подтверждении перезагружает страницу', async () => {
    const { ctx, page } = await openApp(browser, server);
    await addSigs(page, [0]);
    await upgradeDbElsewhere(ctx);
    await page.waitForSelector('#update', { state: 'visible' });
    await addSigs(page, [1]);                   // не сохранится
    await page.evaluate(() => { window.marker = 1; });
    const [message] = await Promise.all([clickConfirm(page, '#update-btn', true), page.waitForEvent('load')]);
    assert.match(message, /: 1\./);
    assert.equal(await page.evaluate(() => window.marker), undefined, 'страница перезагружена');
    await ctx.close();
  });

  test('другая вкладка обновила базу, но несохранённых страниц нет → «Обновить» сразу перезагружает', async () => {
    const { ctx, page } = await openApp(browser, server);
    const dialogs = collectDialogs(page);
    await addSigs(page, [0]);
    await upgradeDbElsewhere(ctx);
    await page.waitForSelector('#update', { state: 'visible' });
    await page.evaluate(() => { window.marker = 1; });
    await Promise.all([page.waitForEvent('load'), page.click('#update-btn')]);
    assert.deepEqual(dialogs, []);
    assert.equal(await page.evaluate(() => window.marker), undefined);
    await ctx.close();
  });
});

describe('сбой записи IndexedDB', () => {
  /** Приложение с версией aaa1111, подменой put/delete и страницами 0 и 1 (сбой включается потом). */
  async function failScenario(fn) {
    const srv = await startServer({ build: 'aaa1111' });
    try {
      const app = await openApp(browser, srv, { init: [idbFailInit] });
      await addSigs(app.page, [0, 1]);
      await swReady(app.page);
      await fn({ srv, ...app });
    } finally { await srv.close(); }
  }
  const release = async (srv, page) => {
    srv.publish('bbb2222');
    await checkUpdate(page);
    await page.waitForSelector('#update', { state: 'visible' });
  };

  for (const mode of ['throw', 'abort']) {
    const what = mode === 'throw' ? 'put бросает исключение' : 'транзакция записи отменяется';
    test(`${what}: страница не сохранена → «Обновить» спрашивает подтверждение`, () => failScenario(async ({ srv, page, errors }) => {
      await page.evaluate(m => { window.__idbFail = { put: m }; }, mode);
      await addSigs(page, [2]);                 // запись не удалась, на экране страница есть
      assert.deepEqual(await pageSigs(page), [0, 1, 2]);
      await release(srv, page);
      await page.evaluate(() => { window.marker = 1; });

      const message = await clickConfirm(page, '#update-btn');
      assert.match(message, /Страниц, не сохранённых в браузере: 1\./);
      assert.equal(await page.evaluate(() => window.marker), 1, 'без согласия страница не перезагружается');
      assert.equal(await pageCount(page), 3);

      // Когда запись снова работает, правка страницы сохраняет её — и вопрос пропадает.
      await page.evaluate(() => { window.__idbFail = {}; });
      await openEditor(page, 3);
      await page.click('#ed-filters [data-f="gray"]');
      await editorDone(page);
      assert.equal((await dbRecords(page)).length, 3, 'третья страница теперь в базе');
      const dialogs = collectDialogs(page);
      await Promise.all([page.waitForEvent('load'), page.click('#update-btn')]);
      await page.waitForFunction(() => document.getElementById('version').textContent === 'Версия: bbb2222');
      await waitPages(page, 3);
      assert.deepEqual(dialogs, [], 'второго вопроса быть не должно');
      assert.deepEqual(errors, [], 'сбой записи обработан приложением, а не выброшен как необработанная ошибка');
    }));
  }

  test('согласие на потерю: страница перезагружается, несохранённая страница пропадает', () => failScenario(async ({ srv, page }) => {
    await page.evaluate(() => { window.__idbFail = { put: 'throw' }; });
    await addSigs(page, [2]);
    await release(srv, page);
    await page.evaluate(() => { window.__idbFail = {}; });
    const [message] = await Promise.all([clickConfirm(page, '#update-btn', true), page.waitForEvent('load')]);
    assert.match(message, /: 1\./);
    await waitPages(page, 2);
    assert.deepEqual(await pageSigs(page), [0, 1]);
  }));

  test('сбой записи при удалении → «Обновить» предупреждает, что удаление не сохранилось', () => failScenario(async ({ srv, page }) => {
    await page.evaluate(() => { window.__idbFail = { delete: 'throw' }; });
    page.once('dialog', d => d.accept()); // «Удалить эту страницу?»
    await page.locator('.page').first().locator('.del').click();
    await waitPages(page, 1);
    await release(srv, page);
    const message = await clickConfirm(page, '#update-btn');
    assert.match(message, /удаление или порядок страниц/);
    assert.equal(await pageCount(page), 1);
  }));

  test('сбой записи при перемещении → то же предупреждение', () => failScenario(async ({ srv, page }) => {
    await page.evaluate(() => { window.__idbFail = { put: 'throw' }; });
    await page.locator('.page').first().locator('.right').click();
    await release(srv, page);
    const message = await clickConfirm(page, '#update-btn');
    assert.match(message, /удаление или порядок страниц/);
    assert.deepEqual(await pageSigs(page), [1, 0]);
  }));

  test('удачная запись порядка снимает предупреждение', () => failScenario(async ({ srv, page }) => {
    await page.evaluate(() => { window.__idbFail = { put: 'throw' }; });
    await page.locator('.page').first().locator('.right').click();     // сбой
    await page.evaluate(() => { window.__idbFail = {}; });
    await page.locator('.page').last().locator('.left').click();       // вернули порядок: запись удалась
    assert.deepEqual(await pageSigs(page), [0, 1]);
    await release(srv, page);
    const dialogs = collectDialogs(page);
    await Promise.all([page.waitForEvent('load'), page.click('#update-btn')]);
    assert.deepEqual(dialogs, []);
  }));

  test('без сбоев «Обновить» не задаёт вопросов', () => failScenario(async ({ srv, page }) => {
    const dialogs = collectDialogs(page);
    await release(srv, page);
    await page.click('#update-btn');
    await page.waitForFunction(() => document.getElementById('version').textContent === 'Версия: bbb2222');
    await waitPages(page, 2);
    assert.deepEqual(dialogs, []);
  }));
});
