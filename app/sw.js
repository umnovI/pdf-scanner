// Кэш приложения для работы без интернета.
// __BUILD__ при публикации заменяется на номер коммита — так у каждой версии
// свой sw.js, и браузер замечает обновление.
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
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Сначала сеть (в обход HTTP-кэша браузера, чтобы сразу получать новую версию),
// без сети — сохранённая копия.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const fresh = e.request.mode === 'navigate'
    ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
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
