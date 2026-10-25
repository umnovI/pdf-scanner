// Хранение страниц в IndexedDB, чтобы скан не пропал при перезагрузке страницы
// (на телефонах браузер часто выгружает вкладку, пока открыта камера).

const DB_NAME = 'pdf-scanner';
const STORE = 'pages';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in self)) { reject(new Error('IndexedDB недоступна')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    const r = fn(store);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function loadAll() {
  const all = (await tx('readonly', s => s.getAll())) || [];
  return all.sort((a, b) => a.order - b.order);
}

export const save = page => tx('readwrite', s => s.put(page));
export const remove = id => tx('readwrite', s => s.delete(id));
export const clear = () => tx('readwrite', s => s.clear());

export async function saveOrder(pages) {
  await tx('readwrite', s => {
    pages.forEach((p, i) => { p.order = i; s.put(p); });
  });
}
