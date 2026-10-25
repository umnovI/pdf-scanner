// Модуль db.js: хранение страниц в IndexedDB, порядок, перенос старого формата, блокировки.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { blankPage, inApp, launch, phone, startServer, unitPage } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const ids = list => list.map(p => p.id);
/** Читает базу «с нуля»: новая загрузка страницы = новое соединение и новый экземпляр db.js. */
const reload = page => page.reload();

describe('сохранение и загрузка', () => {
  test('пустая база: список пуст', async () => {
    const { page } = await unitPage(browser, server);
    assert.deepEqual(await inApp(page, ({ db }) => db.loadAll()), []);
  });

  test('страницы возвращаются в том порядке, в каком сохранены, и после перезагрузки', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db }) => {
      await db.save({ id: 'a', n: 1 }, ['a']);
      await db.save({ id: 'b', n: 2 }, ['a', 'b']);
      await db.save({ id: 'c', n: 3 }, ['a', 'b', 'c']);
    });
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadAll())), ['a', 'b', 'c']);
    await reload(page);
    const list = await inApp(page, ({ db }) => db.loadAll());
    assert.deepEqual(list, [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }]);
  });

  test('повторное сохранение страницы заменяет её, а не дублирует', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db }) => {
      await db.save({ id: 'a', filter: 'enhance' }, ['a']);
      await db.save({ id: 'a', filter: 'bw' }, ['a']);
    });
    assert.deepEqual(await inApp(page, ({ db }) => db.loadAll()), [{ id: 'a', filter: 'bw' }]);
  });

  test('хранит блобы (фото) без потерь', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db, util }) => db.save({ id: 'p', src: await util.mkJpeg(30, 20) }, ['p']));
    await reload(page);
    const r = await inApp(page, async ({ db }) => {
      const [p] = await db.loadAll();
      return { type: p.src.type, big: p.src.size > 100, isBlob: p.src instanceof Blob };
    });
    assert.deepEqual(r, { type: 'image/jpeg', big: true, isBlob: true });
  });
});

describe('порядок, удаление, очистка', () => {
  const seed = ({ db }) => db.save({ id: 'a' }, ['a']).then(() => db.save({ id: 'b' }, ['a', 'b'])).then(() => db.save({ id: 'c' }, ['a', 'b', 'c']));

  test('saveOrder меняет порядок, и он переживает перезагрузку', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, seed);
    await inApp(page, ({ db }) => db.saveOrder(['c', 'a', 'b']));
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadAll())), ['c', 'a', 'b']);
    await reload(page);
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadAll())), ['c', 'a', 'b']);
  });

  test('saveOrder не трогает сами страницы', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db }) => { await db.save({ id: 'a', v: 1 }, ['a']); await db.saveOrder(['a']); });
    assert.deepEqual(await page.evaluate(() => window.raw.all('pages')), [{ id: 'a', v: 1 }]);
  });

  test('remove убирает страницу и обновляет порядок', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, seed);
    await inApp(page, ({ db }) => db.remove('b', ['a', 'c']));
    await reload(page);
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadAll())), ['a', 'c']);
    assert.deepEqual((await page.evaluate(() => window.raw.all('pages'))).map(p => p.id), ['a', 'c']);
  });

  test('новая страница после удаления встаёт в конец', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, seed);
    await inApp(page, async ({ db }) => { await db.remove('a', ['b', 'c']); await db.save({ id: 'd' }, ['b', 'c', 'd']); });
    await reload(page);
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadAll())), ['b', 'c', 'd']);
  });

  test('clear удаляет всё, после чего можно сохранять снова', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, seed);
    await inApp(page, ({ db }) => db.clear());
    await reload(page);
    assert.deepEqual(await page.evaluate(() => window.raw.all('pages')), []);
    assert.deepEqual(await page.evaluate(() => window.raw.all('meta')), []);
    assert.deepEqual(await inApp(page, ({ db }) => db.loadAll()), []);
    await inApp(page, ({ db }) => db.save({ id: 'z' }, ['z']));
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadAll())), ['z']);
  });

  test('сбой записи отменяет её целиком: страница и порядок не расходятся', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, ({ db }) => db.save({ id: 'a' }, ['a']));
    const err = await inApp(page, async ({ db }) => {
      try { await db.save({ id: 'b', bad: () => 1 }, ['a', 'b']); return null; } catch (e) { return e.name; }
    });
    assert.equal(err, 'DataCloneError');
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadAll())), ['a']);
    assert.deepEqual((await page.evaluate(() => window.raw.all('meta'))), [{ key: 'order', ids: ['a'] }]);
  });
});

describe('перенос базы старого формата (v1)', () => {
  test('порядок берётся из поля order и записывается списком; база становится v2', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([
      { id: 'x', order: 2, name: 'третья' }, { id: 'y', order: 0, name: 'первая' }, { id: 'z', order: 1, name: 'вторая' },
    ]));
    const list = await inApp(page, async ({ db }) => {
      const w = [];
      const res = await db.loadAll(p => w.push(p));
      await Promise.all(w);
      return res;
    });
    assert.deepEqual(list.map(p => p.name), ['первая', 'вторая', 'третья']);
    assert.equal(await page.evaluate(() => window.raw.version()), 2);
    assert.deepEqual(await page.evaluate(() => window.raw.all('meta')), [{ key: 'order', ids: ['y', 'z', 'x'] }]);
    // после перезагрузки порядок тот же, и ничего не потеряно
    await reload(page);
    assert.deepEqual((await inApp(page, ({ db }) => db.loadAll())).map(p => p.id), ['y', 'z', 'x']);
  });

  test('одинаковые order (баг старой версии): все страницы на месте, порядок устойчив', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([
      { id: 'a', order: 1 }, { id: 'b', order: 1 }, { id: 'c', order: 0 }, { id: 'd', order: 1 },
    ]));
    const first = await inApp(page, async ({ db }) => {
      const w = [];
      const res = await db.loadAll(p => w.push(p));
      await Promise.all(w);
      return res.map(p => p.id);
    });
    assert.equal(first.length, 4);
    assert.deepEqual([...first].sort(), ['a', 'b', 'c', 'd']);
    assert.equal(first[0], 'c');
    await reload(page);
    // записанный порядок больше не зависит от полей order
    assert.deepEqual((await inApp(page, ({ db }) => db.loadAll())).map(p => p.id), first);
  });

  test('страницы без поля order не теряются', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([{ id: 'p' }, { id: 'q', order: 0 }]));
    const list = await inApp(page, async ({ db }) => {
      const w = [];
      const res = await db.loadAll(p => w.push(p));
      await Promise.all(w);
      return res.map(p => p.id);
    });
    assert.deepEqual([...list].sort(), ['p', 'q']);
  });

  test('после переноса работают сохранение, перемещение и удаление', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([{ id: 'a', order: 0 }, { id: 'b', order: 1 }]));
    const final = await inApp(page, async ({ db }) => {
      const w = [];
      await db.loadAll(p => w.push(p));
      await Promise.all(w);
      await db.save({ id: 'c' }, ['a', 'b', 'c']);
      await db.saveOrder(['c', 'b', 'a']);
      await db.remove('b', ['c', 'a']);
      return (await db.loadAll()).map(p => p.id);
    });
    assert.deepEqual(final, ['c', 'a']);
  });

  test('перенос — отдельная запись, которую можно дождаться; страницы возвращаются сразу', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([{ id: 'a', order: 1 }, { id: 'b', order: 0 }]));
    const r = await inApp(page, async ({ db }) => {
      const w = [];
      const res = await db.loadAll(p => w.push(p));
      return { ids: res.map(p => p.id), writes: w.length };
    });
    assert.deepEqual(r.ids, ['b', 'a']);
    assert.equal(r.writes, 1, 'перенос идёт отдельной записью, которую можно дождаться');
  });
});

describe('«осиротевшие» страницы', () => {
  test('страница, которой нет в списке порядка, не показывается и удаляется из базы', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db }) => { await db.save({ id: 'a' }, ['a']); await db.save({ id: 'b' }, ['a', 'b']); });
    // Остаток неудавшегося удаления: страница есть, а в списке её уже нет.
    await page.evaluate(() => window.raw.put('pages', { id: 'ghost' }));
    await reload(page);
    const list = await inApp(page, async ({ db }) => {
      const w = [];
      const res = await db.loadAll(p => w.push(p));
      await Promise.all(w);
      return res.map(p => p.id);
    });
    assert.deepEqual(list, ['a', 'b']);
    assert.deepEqual((await page.evaluate(() => window.raw.all('pages'))).map(p => p.id), ['a', 'b']);
  });

  test('в списке порядка есть id без страницы — он пропускается', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db }) => { await db.save({ id: 'a' }, ['a', 'нет-такой', 'b']); await db.save({ id: 'b' }, ['a', 'нет-такой', 'b']); });
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadAll())), ['a', 'b']);
  });

  test('чистка не срабатывает, пока всё согласовано (лишних записей нет)', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, ({ db }) => db.save({ id: 'a' }, ['a']));
    const writes = await inApp(page, async ({ db }) => { const w = []; await db.loadAll(p => w.push(p)); return w.length; });
    assert.equal(writes, 0);
  });
});

describe('блокировки между вкладками', () => {
  test('базу держит старая версия: открытие даёт ошибку blocked и не зависает', async () => {
    const { ctx, page: old } = await phone(browser);
    await blankPage(old, server);
    // «Старая вкладка»: база v1 открыта и не отпускается при запросе обновления.
    await old.evaluate(async () => { window.keep = await window.raw.open(1, d => d.createObjectStore('pages', { keyPath: 'id' })); });

    const fresh = await ctx.newPage();
    await blankPage(fresh, server);
    const r = await Promise.race([
      inApp(fresh, async ({ db }) => {
        try { await db.loadAll(); return { ok: true }; } catch (e) { return { blocked: e.blocked === true, message: e.message }; }
      }),
      new Promise(res => setTimeout(() => res('завис'), 10000)),
    ]);
    assert.notEqual(r, 'завис', 'открытие базы зависло');
    assert.equal(r.blocked, true);
    assert.match(r.message, /занята/);
    // следующие операции в этой вкладке тоже сразу отказывают, а не ждут
    const again = await inApp(fresh, async ({ db }) => {
      try { await db.save({ id: 'x' }, ['x']); return 'записалось'; } catch (e) { return e.blocked === true ? 'blocked' : e.message; }
    });
    assert.equal(again, 'blocked');
    await old.evaluate(() => window.keep.close());
    await ctx.close();
  });

  test('старая вкладка закрылась после отказа: база не обновляется «задним числом»', async () => {
    const { ctx, page: old } = await phone(browser);
    await blankPage(old, server);
    await old.evaluate(async () => { window.keep = await window.raw.open(1, d => d.createObjectStore('pages', { keyPath: 'id' })); });
    const fresh = await ctx.newPage();
    await blankPage(fresh, server);
    const blocked = await inApp(fresh, async ({ db }) => { try { await db.loadAll(); return false; } catch (e) { return e.blocked === true; } });
    assert.ok(blocked);
    await old.evaluate(() => window.keep.close());
    // Дальше база остаётся v1: отложенное обновление отменено, соединение не висит.
    const v = await old.evaluate(async () => {
      const db = await window.raw.open(1);
      const stores = [...db.objectStoreNames];
      db.close();
      return { stores };
    });
    assert.deepEqual(v.stores, ['pages']);
    await ctx.close();
  });

  test('другая вкладка обновила формат базы: соединение закрывается, приложению приходит сигнал', async () => {
    const { ctx, page: a } = await phone(browser);
    await blankPage(a, server);
    await inApp(a, async ({ db }) => {
      await db.save({ id: 'p' }, ['p']);
      window.closedSignal = new Promise(res => self.addEventListener('pdf-scanner-db-closed', () => res(true), { once: true }));
    });
    const b = await ctx.newPage();
    await blankPage(b, server);
    // «Новая версия» в другой вкладке: база версии 3. Её открытие дожидается закрытия соединения у первой вкладки.
    const opened = await b.evaluate(async () => {
      const db = await window.raw.open(3, () => {});
      const v = db.version;
      db.close();
      return v;
    });
    assert.equal(opened, 3);
    assert.equal(await a.evaluate(() => window.closedSignal), true);
    const err = await inApp(a, async ({ db }) => {
      const out = {};
      try { await db.save({ id: 'q' }, ['p', 'q']); } catch (e) { out.save = e.message; }
      try { await db.loadAll(); } catch (e) { out.load = e.message; }
      return out;
    });
    assert.match(err.save, /другой вкладкой/);
    assert.match(err.load, /другой вкладкой/);
    await ctx.close();
  });
});
