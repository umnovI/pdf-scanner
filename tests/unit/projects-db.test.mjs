// Модуль db.js, часть «проекты»: makeProject, createProject, savePage, removePages (общие фото),
// deleteProject, loadState (перенос v1/v2, чистка, выбор открытого проекта), loadPages, loadThumbs.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { inApp, launch, startServer, unitPage } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const ids = list => list.map(p => p.id);
const rawAll = (page, store) => page.evaluate(s => window.raw.all(s), store);
const rawPageIds = async page => ids(await rawAll(page, 'pages')).sort();
const rawProject = async (page, id) => (await rawAll(page, 'projects')).find(p => p.id === id);
const rawCurrent = async page => (await rawAll(page, 'meta')).find(m => m.key === 'current')?.id;

/** loadState с ожиданием записей, которые он отдаёт в onWrite. */
const loadState = (page, opts) => inApp(page, async ({ db }, o) => {
  const w = [];
  const st = await db.loadState({ ...o, onWrite: p => w.push(p) });
  await Promise.all(w);
  return { ...st, writes: w.length };
}, opts);

/** Кладёт в базу проекты и страницы напрямую (минуя db.js): p — { id, name, created, filter, ids }. */
const seed = (page, projects, pageIds, current) => page.evaluate(async ([projects, pageIds, current]) => {
  // База v3 создаётся приложением; здесь через db.js — любым вызовом.
  const db = await import('./db.js');
  for (const p of projects) await db.saveProject(p);
  for (const id of pageIds) await db.savePage({ id, thumb: null }, projects[0]);
  if (current === undefined) await window.raw.put('meta', { key: 'current', id: projects[0].id });
  else if (current) await window.raw.put('meta', { key: 'current', id: current });
}, [projects, pageIds, current]);

const P = (id, created, list, extra = {}) => ({ id, name: id, created, filter: 'enhance', ids: list, ...extra });

describe('makeProject и newId', () => {
  test('makeProject: пустой проект с названием, фильтром и уникальным id', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, ({ db }) => {
      const a = db.makeProject('Отпуск');
      const b = db.makeProject('Работа', 'doc');
      return { a, b, ids: [db.newId(), db.newId(), db.newId()] };
    });
    assert.equal(r.a.name, 'Отпуск');
    assert.equal(r.a.filter, 'enhance', 'фильтр по умолчанию — «Улучшить»');
    assert.deepEqual(r.a.ids, []);
    assert.equal(typeof r.a.id, 'string');
    assert.ok(r.a.id.length > 0);
    assert.ok(Math.abs(r.a.created - Date.now()) < 60_000, 'дата создания — сейчас');
    assert.equal(r.b.filter, 'doc');
    assert.notEqual(r.a.id, r.b.id);
    assert.equal(new Set(r.ids).size, 3);
  });
});

describe('createProject, setCurrent, savePage', () => {
  test('createProject записывает проект и делает его открытым', async () => {
    const { page } = await unitPage(browser, server);
    const id = await inApp(page, async ({ db }) => {
      const a = db.makeProject('Первый');
      await db.createProject(a);
      const b = db.makeProject('Второй');
      await db.createProject(b);
      return [a.id, b.id];
    });
    assert.equal(await rawCurrent(page), id[1]);
    assert.deepEqual((await rawAll(page, 'projects')).map(p => p.name).sort(), ['Второй', 'Первый']);
    const st = await loadState(page);
    assert.equal(st.current, id[1]);
    assert.equal(st.projects.length, 2);
  });

  test('setCurrent меняет открытый проект и переживает перезагрузку', async () => {
    const { page } = await unitPage(browser, server);
    const [a, b] = await inApp(page, async ({ db }) => {
      const a = db.makeProject('A'), b = db.makeProject('B');
      await db.createProject(a); await db.createProject(b);
      await db.setCurrent(a.id);
      return [a.id, b.id];
    });
    await page.reload();
    assert.equal((await loadState(page)).current, a);
    assert.notEqual(a, b);
  });

  test('savePage пишет страницу и проект одной транзакцией', async () => {
    const { page } = await unitPage(browser, server);
    const res = await inApp(page, async ({ db }) => {
      const p = db.makeProject('P');
      await db.createProject(p);
      // Слушаем транзакции: запись страницы и проекта — в одной.
      const orig = IDBDatabase.prototype.transaction;
      const log = [];
      IDBDatabase.prototype.transaction = function (...a) {
        const t = orig.apply(this, a);
        const puts = [];
        log.push(puts);
        const os = t.objectStore.bind(t);
        t.objectStore = name => {
          const s = os(name);
          const put = s.put.bind(s);
          s.put = v => { puts.push(name); return put(v); };
          return s;
        };
        return t;
      };
      try { await db.savePage({ id: 'x1' }, { ...p, ids: ['x1'], filter: 'bw' }); } finally { IDBDatabase.prototype.transaction = orig; }
      return log.map(l => l.slice().sort());
    });
    assert.deepEqual(res, [['pages', 'projects']], 'одна транзакция: страница и проект');
    const [proj] = await rawAll(page, 'projects');
    assert.deepEqual(proj.ids, ['x1']);
    assert.equal(proj.filter, 'bw');
    assert.deepEqual(await rawPageIds(page), ['x1']);
  });

  test('сбой savePage: ни страница, ни изменения проекта (фильтр, ссылки) не записываются', async () => {
    const { page } = await unitPage(browser, server);
    const err = await inApp(page, async ({ db }) => {
      const p = db.makeProject('P');
      await db.createProject(p);
      await db.savePage({ id: 'ok' }, { ...p, ids: ['ok'] });
      try { await db.savePage({ id: 'bad', f: () => 1 }, { ...p, ids: ['ok', 'bad'], filter: 'bw' }); return null; } catch (e) { return e.name; }
    });
    assert.equal(err, 'DataCloneError');
    const [proj] = await rawAll(page, 'projects');
    assert.deepEqual(proj.ids, ['ok']);
    assert.equal(proj.filter, 'enhance');
    assert.deepEqual(await rawPageIds(page), ['ok']);
  });
});

describe('removePages: общие фото', () => {
  // Проект A: x, y; проект B: y, z (фото y — общее, хранится один раз).
  const seedShared = page => inApp(page, async ({ db }) => {
    const A = db.makeProject('A'); const B = db.makeProject('B');
    A.ids = ['x', 'y']; B.ids = ['y', 'z'];
    await db.savePage({ id: 'x' }, A);
    await db.savePage({ id: 'y' }, A);
    await db.savePage({ id: 'z' }, B);
    await db.saveProject(B);
    await db.setCurrent(A.id);
    return [A, B];
  });

  test('фото, на которое ссылается другой проект, остаётся; уникальное — удаляется', async () => {
    const { page } = await unitPage(browser, server);
    const [A, B] = await seedShared(page);
    assert.deepEqual(await rawPageIds(page), ['x', 'y', 'z']);
    // Из A убираем x (никто больше не ссылается) и y (ссылается B).
    await inApp(page, ({ db }, [A, B]) => db.removePages({ ...A, ids: [] }, ['x', 'y'], [B]), [A, B]);
    assert.deepEqual(await rawPageIds(page), ['y', 'z'], 'x удалено, общее y осталось');
    assert.deepEqual((await rawProject(page, A.id)).ids, []);
    assert.deepEqual((await rawProject(page, B.id)).ids, ['y', 'z'], 'проект B не тронут');
    // Теперь из B убираем y: на него никто не ссылается — удаляется.
    await inApp(page, ({ db }, [A, B]) => db.removePages({ ...B, ids: ['z'] }, ['y'], [{ ...A, ids: [] }]), [A, B]);
    assert.deepEqual(await rawPageIds(page), ['z']);
  });

  test('если проект сам всё ещё ссылается на фото (повтор в списке), оно не удаляется', async () => {
    const { page } = await unitPage(browser, server);
    const [A, B] = await seedShared(page);
    await inApp(page, ({ db }, [A]) => db.removePages({ ...A, ids: ['y'] }, ['y'], []), [A, B]);
    assert.ok((await rawPageIds(page)).includes('y'));
  });

  test('проект записывается вместе с удалением (атомарно)', async () => {
    const { page } = await unitPage(browser, server);
    const [A, B] = await seedShared(page);
    const err = await inApp(page, async ({ db }, [A, B]) => {
      try { await db.removePages({ ...A, ids: ['y'], bad: () => 1 }, ['x'], [B]); return null; } catch (e) { return e.name; }
    }, [A, B]);
    assert.equal(err, 'DataCloneError');
    assert.deepEqual(await rawPageIds(page), ['x', 'y', 'z'], 'ничего не удалено');
    assert.deepEqual((await rawProject(page, A.id)).ids, ['x', 'y']);
  });
});

describe('deleteProject', () => {
  test('удаляет проект и только фото, на которые больше никто не ссылается; next становится открытым', async () => {
    const { page } = await unitPage(browser, server);
    const [A, B] = await inApp(page, async ({ db }) => {
      const A = db.makeProject('A'); const B = db.makeProject('B');
      A.ids = ['a1', 'both']; B.ids = ['both', 'b1'];
      await db.savePage({ id: 'a1' }, A);
      await db.savePage({ id: 'both' }, A);
      await db.savePage({ id: 'b1' }, B);
      await db.setCurrent(A.id);
      return [A, B];
    });
    await inApp(page, ({ db }, [A, B]) => db.deleteProject(A, [B], B), [A, B]);
    assert.equal(await rawProject(page, A.id), undefined);
    assert.ok(await rawProject(page, B.id));
    assert.equal(await rawCurrent(page), B.id);
    assert.deepEqual(await rawPageIds(page), ['b1', 'both'], 'a1 удалено, общее both осталось');
  });

  test('next записывается как есть (например, новый пустой проект вместо последнего)', async () => {
    const { page } = await unitPage(browser, server);
    const A = await inApp(page, async ({ db }) => {
      const A = db.makeProject('A'); A.ids = ['a1'];
      await db.savePage({ id: 'a1' }, A);
      await db.setCurrent(A.id);
      return A;
    });
    const N = await inApp(page, async ({ db }, A) => {
      const N = db.makeProject('Проект 2');
      await db.deleteProject(A, [N], N);
      return N;
    }, A);
    assert.deepEqual((await rawAll(page, 'projects')).map(p => p.id), [N.id]);
    assert.equal(await rawCurrent(page), N.id);
    assert.deepEqual(await rawPageIds(page), []);
  });

  test('без next (удаляется закрытый проект) открытый проект не меняется', async () => {
    const { page } = await unitPage(browser, server);
    const [A, B] = await inApp(page, async ({ db }) => {
      const A = db.makeProject('A'); const B = db.makeProject('B');
      A.ids = ['a1']; B.ids = ['b1'];
      await db.savePage({ id: 'a1' }, A);
      await db.savePage({ id: 'b1' }, B);
      await db.setCurrent(A.id);
      return [A, B];
    });
    await inApp(page, ({ db }, [A, B]) => db.deleteProject(B, [A], null), [A, B]);
    assert.equal(await rawCurrent(page), A.id);
    assert.deepEqual((await rawAll(page, 'projects')).map(p => p.id), [A.id]);
    assert.deepEqual(await rawPageIds(page), ['a1']);
  });
});

describe('loadState: перенос старых версий', () => {
  /** База формата v2: хранилища pages и meta, порядок в meta.order. */
  const seedV2 = (page, pages, order) => page.evaluate(async ([pages, order]) => {
    const db = await window.raw.open(2, d => {
      d.createObjectStore('pages', { keyPath: 'id' });
      d.createObjectStore('meta', { keyPath: 'key' });
    });
    const t = db.transaction(['pages', 'meta'], 'readwrite');
    pages.forEach(p => t.objectStore('pages').put(p));
    if (order) t.objectStore('meta').put({ key: 'order', ids: order });
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
    db.close();
  }, [pages, order]);

  test('v1 с одинаковыми order: «Проект 1» со всеми страницами в устойчивом порядке; фильтр по умолчанию', async () => {
    const { page } = await unitPage(browser, server);
    await page.evaluate(() => window.raw.seedV1([
      { id: 'a', order: 1 }, { id: 'b', order: 1 }, { id: 'c', order: 0 }, { id: 'd', order: 2 }, { id: 'e', order: 1 },
    ]));
    const st = await loadState(page, { defaultFilter: 'gray' });
    assert.equal(st.projects.length, 1);
    const [p] = st.projects;
    assert.equal(p.name, 'Проект 1');
    assert.equal(p.filter, 'gray');
    assert.equal(st.current, p.id);
    assert.equal(p.ids.length, 5);
    assert.deepEqual([...p.ids].sort(), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(p.ids[0], 'c', 'order 0 первый');
    assert.equal(p.ids[4], 'd', 'order 2 последний');
    assert.equal(await page.evaluate(() => window.raw.version()), 3);
    // записано в базу, повторная загрузка ничего не меняет
    assert.deepEqual((await rawProject(page, p.id)).ids, p.ids);
    await page.reload();
    const again = await loadState(page);
    assert.deepEqual(again.projects.map(x => [x.id, x.ids]), [[p.id, p.ids]]);
    assert.equal(again.writes, 0, 'всё согласовано — писать нечего');
    assert.deepEqual(await rawPageIds(page), ['a', 'b', 'c', 'd', 'e'], 'ни одна страница не потеряна');
  });

  test('v2: порядок из meta.order переходит в «Проект 1», служебный ключ order удаляется', async () => {
    const { page } = await unitPage(browser, server);
    await seedV2(page, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], ['c', 'a', 'd', 'b']);
    const st = await loadState(page);
    assert.equal(st.projects.length, 1);
    assert.equal(st.projects[0].name, 'Проект 1');
    assert.deepEqual(st.projects[0].ids, ['c', 'a', 'd', 'b']);
    assert.equal(await page.evaluate(() => window.raw.version()), 3);
    const meta = await rawAll(page, 'meta');
    assert.equal(meta.find(m => m.key === 'order'), undefined, 'ключ order удалён');
    assert.equal(meta.find(m => m.key === 'current').id, st.projects[0].id);
    assert.deepEqual((await rawProject(page, st.current)).ids, ['c', 'a', 'd', 'b']);
    assert.deepEqual(await rawPageIds(page), ['a', 'b', 'c', 'd']);
  });

  test('v2: страницы вне порядка удаляются, id без страницы убираются', async () => {
    const { page } = await unitPage(browser, server);
    await seedV2(page, [{ id: 'a' }, { id: 'b' }, { id: 'lost' }], ['b', 'нет', 'a']);
    const st = await loadState(page);
    assert.deepEqual(st.projects[0].ids, ['b', 'a']);
    assert.deepEqual(await rawPageIds(page), ['a', 'b'], 'страница без ссылки удалена');
    assert.deepEqual((await rawProject(page, st.current)).ids, ['b', 'a']);
  });

  test('v2 без порядка и без страниц: один пустой «Проект 1»', async () => {
    const { page } = await unitPage(browser, server);
    await seedV2(page, [], null);
    const st = await loadState(page);
    assert.equal(st.projects.length, 1);
    assert.deepEqual(st.projects[0].ids, []);
  });

  test('после переноса данные больше не переносятся: второй проект не получает «старые» страницы', async () => {
    const { page } = await unitPage(browser, server);
    await seedV2(page, [{ id: 'a' }], ['a']);
    const first = await loadState(page);
    await inApp(page, ({ db }) => db.createProject(db.makeProject('Второй')));
    await page.reload();
    const st = await loadState(page);
    assert.equal(st.projects.length, 2);
    assert.deepEqual(st.projects.find(p => p.name === 'Второй').ids, []);
    assert.deepEqual(st.projects.find(p => p.id === first.projects[0].id).ids, ['a']);
  });
});

describe('loadState: чистка и выбор открытого проекта', () => {
  test('фото, на которые не ссылается ни один проект, удаляются; общие и чужие остаются', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page, [P('A', 2, ['a', 'sh']), P('B', 1, ['sh', 'b'])], ['a', 'sh', 'b', 'orphan1', 'orphan2']);
    const st = await loadState(page);
    assert.equal(st.writes, 1);
    assert.deepEqual(await rawPageIds(page), ['a', 'b', 'sh']);
    assert.equal(st.projects.length, 2);
  });

  test('ссылки на отсутствующие фото убираются из проектов, в памяти и в базе', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page, [P('A', 2, ['a', 'пропало', 'sh']), P('B', 1, ['нет', 'sh'])], ['a', 'sh']);
    // seed записал страницы через проект A; уберём лишние ссылки обратно, чтобы они были «висячими»
    await page.evaluate(async () => {
      await window.raw.put('projects', { id: 'A', name: 'A', created: 2, filter: 'enhance', ids: ['a', 'пропало', 'sh'] });
      await window.raw.put('projects', { id: 'B', name: 'B', created: 1, filter: 'enhance', ids: ['нет', 'sh'] });
    });
    const st = await loadState(page);
    assert.deepEqual(st.projects.find(p => p.id === 'A').ids, ['a', 'sh']);
    assert.deepEqual(st.projects.find(p => p.id === 'B').ids, ['sh']);
    assert.deepEqual((await rawProject(page, 'A')).ids, ['a', 'sh'], 'исправление записано в базу');
    assert.deepEqual((await rawProject(page, 'B')).ids, ['sh']);
    assert.equal((await loadState(page)).writes, 0, 'после исправления писать нечего');
  });

  test('проект, у которого не осталось фото, не удаляется — просто пустой', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page, [P('A', 2, ['a']), P('B', 1, [])], ['a']);
    await page.evaluate(() => window.raw.put('projects', { id: 'B', name: 'B', created: 1, filter: 'enhance', ids: ['нет'] }));
    const st = await loadState(page);
    assert.deepEqual(st.projects.find(p => p.id === 'B').ids, []);
    assert.equal(st.projects.length, 2);
  });

  test('проекты — новые сверху; открытый — из meta.current', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page, [P('old', 1, []), P('mid', 5, []), P('new', 9, [])], [], 'mid');
    const st = await loadState(page);
    assert.deepEqual(ids(st.projects), ['new', 'mid', 'old']);
    assert.equal(st.current, 'mid');
  });

  test('current указывает на удалённый проект: открывается самый новый, выбор записывается', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page, [P('old', 1, []), P('new', 9, []), P('mid', 5, [])], [], 'давно-удалён');
    const st = await loadState(page);
    assert.equal(st.current, 'new');
    assert.equal(await rawCurrent(page), 'new');
    assert.equal((await loadState(page)).writes, 0);
  });

  test('current нет совсем: открывается самый новый', async () => {
    const { page } = await unitPage(browser, server);
    await seed(page, [P('old', 1, []), P('new', 9, [])], [], null);
    await page.evaluate(() => window.raw.put('meta', { key: 'other', v: 1 }));
    assert.equal((await loadState(page)).current, 'new');
  });
});

describe('loadPages и loadThumbs', () => {
  test('loadPages: порядок как в списке, отсутствующие пропускаются, пустой список — пусто', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, async ({ db }) => {
      const p = db.makeProject('P'); p.ids = ['a', 'b', 'c'];
      for (const id of p.ids) await db.savePage({ id, n: id }, p);
    });
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadPages(['c', 'a', 'b']))), ['c', 'a', 'b']);
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadPages(['c', 'нет', 'a', 'тоже-нет', 'b']))), ['c', 'a', 'b']);
    assert.deepEqual(await inApp(page, ({ db }) => db.loadPages([])), []);
    assert.deepEqual(await inApp(page, ({ db }) => db.loadPages(['нет'])), []);
  });

  test('loadPages: повторяющийся id возвращает страницу столько раз, сколько он указан', async () => {
    const { page } = await unitPage(browser, server);
    await inApp(page, ({ db }) => db.savePage({ id: 'a' }, { ...db.makeProject('P'), ids: ['a'] }));
    assert.deepEqual(ids(await inApp(page, ({ db }) => db.loadPages(['a', 'a']))), ['a', 'a']);
  });

  test('loadThumbs: миниатюры по порядку, null для отсутствующих страниц и страниц без миниатюры', async () => {
    const { page } = await unitPage(browser, server);
    const r = await inApp(page, async ({ db, util }) => {
      const p = db.makeProject('P'); p.ids = ['a', 'b', 'c'];
      await db.savePage({ id: 'a', thumb: await util.mkJpeg(40, 30) }, p);
      await db.savePage({ id: 'b' }, p);
      await db.savePage({ id: 'c', thumb: await util.mkJpeg(10, 10) }, p);
      const out = await db.loadThumbs(['c', 'нет', 'b', 'a']);
      return out.map(t => t && { isBlob: t instanceof Blob, type: t.type, size: t.size });
    });
    assert.equal(r.length, 4);
    assert.equal(r[0].isBlob, true);
    assert.equal(r[0].type, 'image/jpeg');
    assert.equal(r[1], null);
    assert.equal(r[2], null);
    assert.ok(r[3].size > r[0].size, 'a (40x30) больше c (10x10)');
  });

  test('loadThumbs: пустой список', async () => {
    const { page } = await unitPage(browser, server);
    assert.deepEqual(await inApp(page, ({ db }) => db.loadThumbs([])), []);
  });
});
