// Хранение в IndexedDB, чтобы сканы не пропадали при перезагрузке страницы
// (на телефонах браузер часто выгружает вкладку, пока открыта камера).
//
// - «pages»    — фото страниц (каждое хранится один раз);
// - «projects» — проекты: название, фильтр по умолчанию и список id страниц
//                 по порядку. Проект только ссылается на фото, не копирует их;
// - «meta»     — служебное: какой проект открыт (ключ «current»).
// Изменение страницы и проекта, к которому она относится, пишется одной
// транзакцией, поэтому они не расходятся.

const DB_NAME = 'pdf-scanner';
const PAGES = 'pages';
const META = 'meta';
const PROJECTS = 'projects';
const STORES = [PAGES, META, PROJECTS];
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in self)) { reject(new Error('IndexedDB недоступна')); return; }
      let blocked = false;
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = () => {
        // Уже отказались из-за блокировки — не обновляем базу, которой не пользуемся.
        if (blocked) { req.transaction.abort(); return; }
        const db = req.result;
        if (!db.objectStoreNames.contains(PAGES)) db.createObjectStore(PAGES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Открылась уже после отказа (старая вкладка закрылась) — эта вкладка
        // работает без сохранения, соединение не нужно.
        if (blocked) { db.close(); return; }
        // Новая версия приложения в другой вкладке обновляет базу — отпускаем её
        // и сообщаем приложению: дальше сохранять нельзя, нужна перезагрузка.
        db.onversionchange = () => {
          db.close();
          dbPromise = Promise.reject(new Error('База обновлена другой вкладкой'));
          dbPromise.catch(() => {});
          self.dispatchEvent(new Event('pdf-scanner-db-closed'));
        };
        resolve(db);
      };
      req.onerror = e => { e.preventDefault(); reject(req.error); };
      // Базу держит открытой старая версия в другой вкладке — не ждём бесконечно.
      req.onblocked = () => {
        blocked = true;
        reject(Object.assign(new Error('База занята другой вкладкой'), { blocked: true }));
      };
    });
  }
  return dbPromise;
}

// Выполняет fn({ pages, meta, projects }) в одной транзакции; ждёт её завершения.
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORES, mode);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    try {
      fn({ pages: t.objectStore(PAGES), meta: t.objectStore(META), projects: t.objectStore(PROJECTS) });
    } catch (e) {
      try { t.abort(); } catch { /* транзакция уже завершена */ } // не оставляем половину записи
      reject(e);
    }
  });
}

// Результат запроса — в колбэк, прямо в обработчике успеха (транзакция ещё активна).
const onResult = (req, fn) => { req.onsuccess = () => fn(req.result); };

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Пустой проект. */
export function makeProject(name, filter = 'enhance') {
  return { id: newId(), name, created: Date.now(), filter, ids: [] };
}

/**
 * Состояние при запуске: список проектов (новые сверху) и id открытого.
 * Переносит данные старых версий: v2 (порядок в meta.order) и v1 (поле order
 * у страниц) становятся проектом «Проект 1». Убирает фото, на которые не
 * ссылается ни один проект, и ссылки на отсутствующие фото. Эту запись передаёт
 * в onWrite, чтобы её можно было дождаться; её сбой не мешает загрузке.
 */
export async function loadState({ defaultFilter = 'enhance', onWrite = p => p.catch(console.warn) } = {}) {
  let order, projects = [], current, keys = [];
  await tx('readonly', s => {
    onResult(s.meta.get('order'), r => { order = r?.ids; });
    onResult(s.meta.get('current'), r => { current = r?.id; });
    onResult(s.projects.getAll(), r => { projects = r || []; });
    onResult(s.pages.getAllKeys(), r => { keys = r || []; }); // без загрузки фото
  });
  const existing = new Set(keys);

  let changed = false;
  if (!projects.length) {
    let ids = order;
    if (!ids) {
      // Данные версии v1: порядок — в поле order каждой страницы. Читаем
      // записи один раз, только при переносе.
      const legacy = [];
      await tx('readonly', s => {
        const cur = s.pages.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          legacy.push([c.key, c.value.order ?? 0]);
          c.continue();
        };
      });
      ids = legacy.sort((a, b) => a[1] - b[1]).map(x => x[0]);
    }
    const p = makeProject('Проект 1', defaultFilter);
    p.ids = ids.filter(id => existing.has(id));
    projects = [p];
    changed = true;
  }
  for (const p of projects) {
    const ids = p.ids.filter(id => existing.has(id));
    if (ids.length !== p.ids.length) { p.ids = ids; changed = true; }
  }
  projects.sort((a, b) => b.created - a.created);
  if (!projects.some(p => p.id === current)) { current = projects[0].id; changed = true; }
  const used = new Set(projects.flatMap(p => p.ids));
  const orphans = keys.filter(id => !used.has(id));
  if (changed || orphans.length || order) {
    const fixed = projects.map(p => ({ ...p, ids: [...p.ids] }));
    onWrite(tx('readwrite', s => {
      fixed.forEach(p => s.projects.put(p));
      s.meta.put({ key: 'current', id: current });
      s.meta.delete('order');
      orphans.forEach(id => s.pages.delete(id));
    }));
  }
  return { projects, current };
}

/** Страницы по списку id, в том же порядке (отсутствующие пропускаются). */
export async function loadPages(ids) {
  const out = new Array(ids.length);
  await tx('readonly', s => {
    ids.forEach((id, i) => onResult(s.pages.get(id), p => { out[i] = p; }));
  });
  return out.filter(Boolean);
}

/** Миниатюры страниц по списку id (null, если страницы нет) — одним запросом. */
export async function loadThumbs(ids) {
  const out = ids.map(() => null);
  await tx('readonly', s => {
    ids.forEach((id, i) => onResult(s.pages.get(id), p => { out[i] = p?.thumb || null; }));
  });
  return out;
}

/** Сохраняет страницу вместе с проектом (порядок, название, фильтр). */
export const savePage = (page, project) => tx('readwrite', s => {
  s.pages.put(page);
  s.projects.put(project);
});

export const saveProject = project => tx('readwrite', s => { s.projects.put(project); });

export const setCurrent = id => tx('readwrite', s => { s.meta.put({ key: 'current', id }); });

/** Новый проект сразу становится открытым. */
export const createProject = project => tx('readwrite', s => {
  s.projects.put(project);
  s.meta.put({ key: 'current', id: project.id });
});

// Удаляет фото из ids, на которые не ссылается ни один из проектов keep.
function dropUnused(s, ids, keep) {
  const used = new Set(keep.flatMap(p => p.ids));
  ids.filter(id => !used.has(id)).forEach(id => s.pages.delete(id));
}

/**
 * Записывает проект после удаления из него страниц removed; фото удаляются,
 * если на них больше не ссылается ни один проект (others — остальные проекты).
 */
export const removePages = (project, removed, others) => tx('readwrite', s => {
  s.projects.put(project);
  dropUnused(s, removed, [project, ...others]);
});

/** Удаляет проект и фото, на которые больше никто не ссылается; next — открываемый проект. */
export const deleteProject = (project, others, next) => tx('readwrite', s => {
  s.projects.delete(project.id);
  if (next) {
    s.projects.put(next);
    s.meta.put({ key: 'current', id: next.id });
  }
  dropUnused(s, project.ids, others);
});
