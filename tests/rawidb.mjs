// Прямая работа с IndexedDB «pdf-scanner» из тестов: подготовить базу старого
// формата, посмотреть, что реально записано. Функция выполняется в браузере
// (page.addInitScript(rawIdbInit)) и создаёт window.raw.
export function rawIdbInit() {
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  window.raw = {
    open(version, upgrade) {
      return new Promise((res, rej) => {
        const r = indexedDB.open('pdf-scanner', version);
        if (upgrade) r.onupgradeneeded = () => upgrade(r.result, r);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    // База формата v1: хранилище pages, порядок — полем order у каждой страницы.
    async seedV1(pages) {
      const db = await this.open(1, d => d.createObjectStore('pages', { keyPath: 'id' }));
      const t = db.transaction('pages', 'readwrite');
      pages.forEach(p => t.objectStore('pages').put(p));
      await done(t);
      db.close();
    },
    async all(store) {
      const db = await this.open();
      try {
        if (!db.objectStoreNames.contains(store)) return null;
        return await req(db.transaction(store).objectStore(store).getAll());
      } finally { db.close(); }
    },
    async version() { const db = await this.open(); const v = db.version; db.close(); return v; },
    async put(store, value) {
      const db = await this.open();
      const t = db.transaction(store, 'readwrite');
      t.objectStore(store).put(value);
      await done(t);
      db.close();
    },
  };
}
