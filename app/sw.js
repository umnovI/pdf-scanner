// Кэш приложения для работы без интернета.
// При публикации строка версии ниже заменяется на номер коммита — так у каждой
// версии свой sw.js, и браузер замечает обновление. Локально остаётся «__BUILD__»:
// при разработке включите в DevTools → Application → Service workers «Update on reload».
const VERSION = '__BUILD__';
const CACHE = 'pdf-scanner-' + VERSION;
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'imgproc.js',
  'pdf.js',
  'db.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' — берём файлы с сервера, а не из HTTP-кэша браузера,
  // иначе в кэш новой версии могут попасть файлы предыдущей.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
      // Сообщаем открытым страницам свою версию: так они узнают об обновлении.
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(list => list.forEach(c => c.postMessage({ type: 'version', version: VERSION }))),
  );
});

// Страница спрашивает версию, чтобы понять, сменилась ли она.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'version' && e.source) {
    e.source.postMessage({ type: 'version', version: VERSION });
  }
});

// Сначала сеть (в обход HTTP-кэша браузера, чтобы сразу получать новую версию),
// без сети — сохранённая копия.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const fresh = e.request.mode === 'navigate'
    ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' })
    : fetch(new Request(e.request, { cache: 'no-cache' }));
  e.respondWith(
    fresh
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
