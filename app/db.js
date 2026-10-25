// Хранение страниц в IndexedDB, чтобы скан не пропал при перезагрузке страницы
// (на телефонах браузер часто выгружает вкладку, пока открыта камера).
//
// Страницы (фото и настройки) лежат в хранилище «pages», а порядок — одним
// списком id в «meta» под ключом «order». Так перемещение страницы не
// переписывает фото, а добавление и удаление меняют страницу и список вместе.

const DB_NAME = 'pdf-scanner';
const PAGES = 'pages';
const META = 'meta';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in self)) { reject(new Error('IndexedDB недоступна')); return; }
      let blocked = false;
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PAGES)) db.createObjectStore(PAGES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
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
          dbPromise = Promise.reject(Object.assign(new Error('База обновлена другой вкладкой'), { closed: true }));
          dbPromise.catch(() => {});
          self.dispatchEvent(new Event('pdf-scanner-db-closed'));
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      // Базу держит открытой старая версия в другой вкладке — не ждём бесконечно.
      req.onblocked = () => {
        blocked = true;
        reject(Object.assign(new Error('База занята другой вкладкой'), { blocked: true }));
      };
    });
  }
  return dbPromise;
}

// Выполняет fn над обоими хранилищами в одной транзакции; ждёт её завершения.
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction([PAGES, META], mode);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
    try {
      fn(t.objectStore(PAGES), t.objectStore(META));
    } catch (e) {
      t.abort(); // не оставляем половину записи
      reject(e);
    }
  });
}

const putOrder = (meta, ids) => meta.put({ key: 'order', ids });

// Страницы в сохранённом порядке. Читаем без записи, а перенос данных старой
// версии и чистку лишних записей делаем отдельной записью — её сбой не мешает
// загрузке. Эту запись передаём в onWrite, чтобы её можно было дождаться.
export async function loadAll(onWrite = () => {}) {
  let list = [], ids;
  await tx('readonly', (pages, meta) => {
    const all = pages.getAll();
    const order = meta.get('order');
    all.onsuccess = () => { list = all.result || []; };
    order.onsuccess = () => { ids = order.result?.ids; };
  });
  const migrate = !ids;
  if (migrate) {
    // Данные старой версии: порядок был в поле order каждой страницы.
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    ids = list.map(p => p.id);
  }
  const keep = new Set(ids);
  // Страница, которой нет в списке, осталась от неудавшегося удаления.
  const orphans = list.filter(p => !keep.has(p.id)).map(p => p.id);
  if (migrate || orphans.length) {
    onWrite(tx('readwrite', (pages, meta) => {
      if (migrate) putOrder(meta, ids);
      orphans.forEach(id => pages.delete(id));
    }));
  }
  const byId = new Map(list.map(p => [p.id, p]));
  return ids.map(id => byId.get(id)).filter(Boolean);
}

// Сохраняет страницу вместе с текущим порядком (список id — несколько байт),
// чтобы страница в базе никогда не оказалась вне списка.
export const save = (page, ids) => tx('readwrite', (pages, meta) => {
  pages.put(page);
  putOrder(meta, ids);
});

export const saveOrder = ids => tx('readwrite', (pages, meta) => { putOrder(meta, ids); });

export const remove = (id, ids) => tx('readwrite', (pages, meta) => {
  pages.delete(id);
  putOrder(meta, ids);
});

export const clear = () => tx('readwrite', (pages, meta) => { pages.clear(); meta.clear(); });
