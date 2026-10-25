// Модуль db.js: хранение страниц и проектов в IndexedDB, порядок, перенос старого формата, блокировки.
// Проекты, общие фото и перенос v1/v2 подробно — в projects-db.test.mjs.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { blankPage, inApp, launch, phone, startServer, unitPage } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const ids = list => list.map(p => p.id);
/** Читает базу «с нуля»: новая загрузка страницы = новое соединение и новый экземпляр db.js. */
const reload = page => page.reload();
/** Проект «P» (как его хранит приложение) со списком страниц. */
const proj = (list, extra = {}) => ({ id: 'P', name: 'P', created: 1, filter: 'enhance', ids: list, ...extra });

/** loadState с ожиданием записей (перенос, чистка); writes — сколько их было. */
const loadState = page => inApp(page, async ({ db }) => {
  const w = [];
  const st = await db.loadState({ onWrite: p => w.push(p) });
  await Promise.all(w);
  return { ...st, writes: w.length };
});

/** Сохраняет страницы по одной (каждая вместе с проектом, где уже есть она и предыдущие). */
const savePages = (page, list, order) => inApp(page, async ({ db }, [list, order]) => {
  for (const [i, pg] of list.entries()) {
    await db.savePage(pg, { id: 'P', name: 'P', created: 1, filter: 'enhance', ids: order.slice(0, i + 1) });
  }
}, [list, order]);

describe('сохранение и загрузка', () => {
  test('пустая база: loadState создаёт «Проект 1» и открывает его', async () => {
    const { page } = await unitPage(browser, server);
    const st = await loadState(page);
    assert.equal(st.projects.length, 1);
    assert.equal(st.projects[0].name, 'Проект 1');
    assert.deepEqual(st.projects[0].ids, []);
    assert.equal(st.current, st.projects[0].id);
  });

  test('страницы возвращаются в том порядке, в каком сохранены, и после перезагрузки', async () => {
    const { page } = await unitPage(browser, server);
    await savePages(page, [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }], ['a', 'b', 'c']);
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadPages(['a', 'b', 'c']))), ['a', 'b', 'c']);
    await reload(page);
    const { projects } = await loadState(page);
    const list = await inApp(page, ({ db }, i) => db.loadPages(i), projects[0].ids);
    assert.deepEqual(list, [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }]);
  });

  test('повторное сохранение страницы заменяет её, а не дублирует', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db }) => {
      const pr = { id: 'P', name: 'P', created: 1, filter: 'enhance', ids: ['a'] };
      await db.savePage({ id: 'a', filter: 'enhance' }, pr);
      await db.savePage({ id: 'a', filter: 'bw' }, pr);
    });
    assert.deepEqual(await inApp(page, ({ db }) => db.loadPages(['a'])), [{ id: 'a', filter: 'bw' }]);
    assert.equal((await page.evaluate(() => window.raw.all('pages'))).length, 1);
  });

  test('хранит блобы (фото) без потерь', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db, util }) =>
      db.savePage({ id: 'p', src: await util.mkJpeg(30, 20) }, { id: 'P', name: 'P', created: 1, filter: 'enhance', ids: ['p'] }));
    await reload(page);
    const r = await inApp(page, async ({ db }) => {
      const [p] = await db.loadPages(['p']);
      return { type: p.src.type, big: p.src.size > 100, isBlob: p.src instanceof Blob };
    });
    assert.deepEqual(r, { type: 'image/jpeg', big: true, isBlob: true });
  });
});

describe('порядок, удаление, очистка', () => {
  const seed = page => savePages(page, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['a', 'b', 'c']);

  test('saveProject меняет порядок, и он переживает перезагрузку', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page);
    await inApp(page, ({ db }, p) => db.saveProject(p), proj(['c', 'a', 'b']));
    await reload(page);
    assert.deepEqual((await loadState(page)).projects[0].ids, ['c', 'a', 'b']);
  });

  test('saveProject не трогает сами страницы', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db }, p) => { await db.savePage({ id: 'a', v: 1 }, p); await db.saveProject(p); }, proj(['a']));
    assert.deepEqual(await page.evaluate(() => window.raw.all('pages')), [{ id: 'a', v: 1 }]);
  });

  test('removePages убирает страницу из проекта и из базы', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page);
    await inApp(page, ({ db }, p) => db.removePages(p, ['b'], []), proj(['a', 'c']));
    await reload(page);
    assert.deepEqual((await loadState(page)).projects[0].ids, ['a', 'c']);
    assert.deepEqual((await page.evaluate(() => window.raw.all('pages'))).map(p => p.id).sort(), ['a', 'c']);
  });

  test('новая страница после удаления встаёт в конец', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page);
    await inApp(page, async ({ db }) => {
      const mk = list => ({ id: 'P', name: 'P', created: 1, filter: 'enhance', ids: list });
      await db.removePages(mk(['b', 'c']), ['a'], []);
      await db.savePage({ id: 'd' }, mk(['b', 'c', 'd']));
    });
    await reload(page);
    assert.deepEqual((await loadState(page)).projects[0].ids, ['b', 'c', 'd']);
  });

  test('удаление проекта убирает всё; после этого можно сохранять снова', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page);
    await inApp(page, async ({ db }) => {
      const N = db.makeProject('Новый');
      await db.deleteProject({ id: 'P', name: 'P', created: 1, filter: 'enhance', ids: ['a', 'b', 'c'] }, [N], N);
    });
    await reload(page);
    assert.deepEqual(await page.evaluate(() => window.raw.all('pages')), []);
    assert.deepEqual((await page.evaluate(() => window.raw.all('projects'))).map(p => p.name), ['Новый']);
    const st = await loadState(page);
    assert.deepEqual(st.projects[0].ids, []);
    await inApp(page, ({ db }, id) => db.savePage({ id: 'z' }, { id, name: 'Новый', created: 2, filter: 'enhance', ids: ['z'] }), st.current);
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadPages(['z']))), ['z']);
  });

  test('сбой записи отменяет её целиком: страница и проект не расходятся', async () => {
    const { page } = await unitPage(browser, server);
    await savePages(page, [{ id: 'a' }], ['a']);
    const err = await inApp(page, async ({ db }) => {
      try {
        await db.savePage({ id: 'b', bad: () => 1 }, { id: 'P', name: 'P', created: 1, filter: 'enhance', ids: ['a', 'b'] });
        return null;
      } catch (e) { return e.name; }
    });
    assert.equal(err, 'DataCloneError');
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadPages(['a', 'b']))), ['a']);
    assert.deepEqual((await page.evaluate(() => window.raw.all('projects')))[0].ids, ['a']);
  });
});

describe('перенос базы старого формата (v1)', () => {
  test('порядок берётся из поля order и записывается в проект; база становится v3', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([
      { id: 'x', order: 2, name: 'третья' }, { id: 'y', order: 0, name: 'первая' }, { id: 'z', order: 1, name: 'вторая' },
    ]));
    const st = await loadState(page);
    assert.deepEqual(st.projects[0].ids, ['y', 'z', 'x']);
    const list = await inApp(page, ({ db }, i) => db.loadPages(i), st.projects[0].ids);
    assert.deepEqual(list.map(p => p.name), ['первая', 'вторая', 'третья']);
    assert.equal(await page.evaluate(() => window.raw.version()), 3);
    // после перезагрузки порядок тот же, и ничего не потеряно
    await reload(page);
    assert.deepEqual((await loadState(page)).projects[0].ids, ['y', 'z', 'x']);
  });

  test('одинаковые order (баг старой версии): все страницы на месте, порядок устойчив', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([
      { id: 'a', order: 1 }, { id: 'b', order: 1 }, { id: 'c', order: 0 }, { id: 'd', order: 1 },
    ]));
    const first = (await loadState(page)).projects[0].ids;
    assert.equal(first.length, 4);
    assert.deepEqual([...first].sort(), ['a', 'b', 'c', 'd']);
    assert.equal(first[0], 'c');
    await reload(page);
    // записанный порядок больше не зависит от полей order
    assert.deepEqual((await loadState(page)).projects[0].ids, first);
  });

  test('страницы без поля order не теряются', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([{ id: 'p' }, { id: 'q', order: 0 }]));
    assert.deepEqual([...(await loadState(page)).projects[0].ids].sort(), ['p', 'q']);
  });

  test('после переноса работают сохранение, перемещение и удаление', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([{ id: 'a', order: 0 }, { id: 'b', order: 1 }]));
    const final = await inApp(page, async ({ db }) => {
      const w = [];
      const { projects } = await db.loadState({ onWrite: p => w.push(p) });
      await Promise.all(w);
      const P = projects[0];
      await db.savePage({ id: 'c' }, { ...P, ids: ['a', 'b', 'c'] });
      await db.saveProject({ ...P, ids: ['c', 'b', 'a'] });
      await db.removePages({ ...P, ids: ['c', 'a'] }, ['b'], []);
      return (await db.loadState()).projects[0].ids;
    });
    assert.deepEqual(final, ['c', 'a']);
  });

  test('перенос — отдельная запись, которую можно дождаться; проекты возвращаются сразу', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([{ id: 'a', order: 1 }, { id: 'b', order: 0 }]));
    const r = await inApp(page, async ({ db }) => {
      const w = [];
      const res = await db.loadState({ onWrite: p => w.push(p) });
      return { ids: res.projects[0].ids, writes: w.length };
    });
    assert.deepEqual(r.ids, ['b', 'a']);
    assert.equal(r.writes, 1, 'перенос идёт отдельной записью, которую можно дождаться');
  });
});

describe('«осиротевшие» страницы', () => {
  test('страница, на которую не ссылается проект, не показывается и удаляется из базы', async () => {
    const { page } = await unitPage(browser, server);
    await savePages(page, [{ id: 'a' }, { id: 'b' }], ['a', 'b']);
    // Остаток неудавшегося удаления: страница есть, а в проекте её уже нет.
    await page.evaluate(() => window.raw.put('pages', { id: 'ghost' }));
    await reload(page);
    const st = await loadState(page);
    assert.deepEqual(st.projects[0].ids, ['a', 'b']);
    assert.deepEqual((await page.evaluate(() => window.raw.all('pages'))).map(p => p.id).sort(), ['a', 'b']);
  });

  test('в проекте есть id без страницы — он пропускается', async () => {
    const { page } = await unitPage(browser, server);
    await savePages(page, [{ id: 'a' }, { id: 'b' }], ['a', 'b']);
    await inApp(page, ({ db }, p) => db.saveProject(p), proj(['a', 'нет-такой', 'b']));
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadPages(['a', 'нет-такой', 'b']))), ['a', 'b']);
    assert.deepEqual((await loadState(page)).projects[0].ids, ['a', 'b'], 'ссылка на отсутствующее фото убрана');
  });

  test('чистка не срабатывает, пока всё согласовано (лишних записей нет)', async () => {
    const { page } = await unitPage(browser, server);
    await savePages(page, [{ id: 'a' }], ['a']);
    await page.evaluate(() => window.raw.put('meta', { key: 'current', id: 'P' }));
    assert.equal((await loadState(page)).writes, 0);
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
        try { await db.loadState(); return { ok: true }; } catch (e) { return { blocked: e.blocked === true, message: e.message }; }
      }),
      new Promise(res => setTimeout(() => res('завис'), 10000)),
    ]);
    assert.notEqual(r, 'завис', 'открытие базы зависло');
    assert.equal(r.blocked, true);
    assert.match(r.message, /занята/);
    // следующие операции в этой вкладке тоже сразу отказывают, а не ждут
    const again = await inApp(fresh, async ({ db }) => {
      try {
        await db.savePage({ id: 'x' }, { id: 'P', name: 'P', created: 1, filter: 'enhance', ids: ['x'] });
        return 'записалось';
      } catch (e) { return e.blocked === true ? 'blocked' : e.message; }
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
    const blocked = await inApp(fresh, async ({ db }) => { try { await db.loadState(); return false; } catch (e) { return e.blocked === true; } });
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
      await db.savePage({ id: 'p' }, { id: 'P', name: 'P', created: 1, filter: 'enhance', ids: ['p'] });
      window.closedSignal = new Promise(res => self.addEventListener('pdf-scanner-db-closed', () => res(true), { once: true }));
    });
    const b = await ctx.newPage();
    await blankPage(b, server);
    // «Новая версия» в другой вкладке: база версии 4. Её открытие дожидается закрытия соединения у первой вкладки.
    const opened = await b.evaluate(async () => {
      const db = await window.raw.open(4, () => {});
      const v = db.version;
      db.close();
      return v;
    });
    assert.equal(opened, 4);
    assert.equal(await a.evaluate(() => window.closedSignal), true);
    const err = await inApp(a, async ({ db }) => {
      const out = {};
      try { await db.savePage({ id: 'q' }, { id: 'P', name: 'P', created: 1, filter: 'enhance', ids: ['p', 'q'] }); } catch (e) { out.save = e.message; }
      try { await db.loadState(); } catch (e) { out.load = e.message; }
      return out;
    });
    assert.match(err.save, /другой вкладкой/);
    assert.match(err.load, /другой вкладкой/);
    await ctx.close();
  });
});
