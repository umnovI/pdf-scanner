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
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PAGES)) db.createObjectStore(PAGES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
      };
      req.onsuccess = () => {
        const db = req.result;
        // Новая версия приложения в другой вкладке обновляет базу — отпускаем её.
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      // Базу держит открытой старая версия в другой вкладке — не ждём бесконечно.
      req.onblocked = () => reject(Object.assign(new Error('База занята другой вкладкой'), { blocked: true }));
    });
  }
  return dbPromise;
}

// Выполняет fn над обоими хранилищами в одной транзакции; ждёт её завершения.
async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction([PAGES, META], mode);
    fn(t.objectStore(PAGES), t.objectStore(META));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const putOrder = (meta, ids) => meta.put({ key: 'order', ids });

// Страницы в сохранённом порядке. Читаем без записи, а перенос данных старой
// версии и чистку лишних записей делаем отдельно — их сбой не мешает загрузке.
export async function loadAll() {
  let list = [], ids;
  await tx('readonly', (pages, meta) => {
    const all = pages.getAll();
    const order = meta.get('order');
    all.onsuccess = () => { list = all.result || []; };
    order.onsuccess = () => { ids = order.result?.ids; };
  });
  const fixes = [];
  if (!ids) {
    // Данные старой версии: порядок был в поле order каждой страницы.
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    ids = list.map(p => p.id);
    fixes.push(meta => putOrder(meta, ids));
  }
  const keep = new Set(ids);
  // Страница, которой нет в списке, осталась от неудавшегося удаления.
  const orphans = list.filter(p => !keep.has(p.id)).map(p => p.id);
  if (orphans.length) fixes.push((meta, pages) => orphans.forEach(id => pages.delete(id)));
  if (fixes.length) {
    tx('readwrite', (pages, meta) => fixes.forEach(f => f(meta, pages))).catch(console.warn);
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
