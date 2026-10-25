// Изоляция кэшей service worker (выполняется в node:vm, без браузера).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../../app/sw.js', import.meta.url), 'utf8');
const scope = 'https://example.test/pdf-scanner/';
const prefix = 'pdf-scanner:' + encodeURIComponent(scope) + ':';
const current = prefix + '__BUILD__';

function worker(initial = new Map()) {
  const handlers = new Map();
  const messages = [];
  const stores = new Map(initial);
  const self = {
    registration: { scope },
    addEventListener: (type, handler) => handlers.set(type, handler),
    clients: {
      claim: async () => {},
      matchAll: async () => [scope, 'https://example.test/other/'].map(url => ({
        url, postMessage: data => messages.push({ url, data }),
      })),
    },
  };
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async key => stores.delete(key),
    open: async key => {
      if (!stores.has(key)) stores.set(key, new Map());
      return {
        // Как Cache.match: строка или запрос, адрес относительно scope, опция ignoreSearch.
        match: async (request, options = {}) => {
          const norm = u => {
            const x = new URL(typeof u === 'string' ? u : u.url, scope);
            if (options.ignoreSearch) x.search = '';
            return x.href;
          };
          const wanted = norm(request);
          for (const [k, v] of stores.get(key)) if (norm(k) === wanted) return v.clone();
          return undefined;
        },
      };
    },
    // Чтение из общего Cache Storage недопустимо даже при промахе своего кэша.
    match: () => { throw new Error('Чтение чужих кэшей'); },
  };
  vm.runInNewContext(source, {
    self, caches, URL, Request, Response,
    fetch: async () => { throw new Error('offline'); },
  });
  return { handlers, stores, messages };
}

test('активация удаляет только старые версии своего scope', async () => {
  const keep = [current, 'other-app-v1', 'pdf-scanner-legacy',
    'pdf-scanner:' + encodeURIComponent(scope + '-nested/') + ':v1'];
  const { handlers, stores, messages } = worker(new Map(
    [...keep, prefix + 'previous'].map(key => [key, new Map()]),
  ));
  let completion;
  handlers.get('activate')({ waitUntil: promise => { completion = promise; } });
  await completion;
  assert.deepEqual([...stores.keys()], keep);
  assert.deepEqual(messages.map(message => message.url), [scope]);
});

test('офлайн-ответ берётся только из кэша текущей версии', async () => {
  const url = scope + 'app.js';
  const own = new Response('own');
  const { handlers, stores } = worker(new Map([
    ['other-app-v1', new Map([[url, new Response('foreign')]])],
    [current, new Map([[url, own]])],
  ]));
  const request = new Request(url);
  let response;
  const event = { request, respondWith: promise => { response = promise; } };
  handlers.get('fetch')(event);
  assert.equal(await (await response).text(), 'own');
  stores.get(current).delete(url);
  handlers.get('fetch')(event);
  const miss = await response;
  assert.equal(miss.type, 'error', 'без копии — ошибка сети, а не чужой ответ');
});

/** Запускает обработчик fetch и возвращает ответ воркера. */
async function ask(handlers, request) {
  let response;
  handlers.get('fetch')({ request, respondWith: promise => { response = promise; } });
  return response;
}
/** Навигация: в node Request.mode выставить нельзя, поэтому свой объект запроса. */
const navigation = url => ({ url, method: 'GET', mode: 'navigate' });

test('офлайн-навигация на неизвестный адрес внутри scope отдаёт закэшированную «./»', async () => {
  const { handlers } = worker(new Map([[current, new Map([[scope, new Response('home')]])]]));
  for (const url of [scope + '?share=1', scope + 'unknown']) {
    assert.equal(await (await ask(handlers, navigation(url))).text(), 'home', url);
  }
});

test('офлайн-навигация на адрес с параметром, который есть в кэше без параметра, отдаёт его копию', async () => {
  const { handlers } = worker(new Map([[current, new Map([
    [scope, new Response('home')], [scope + 'page.html', new Response('page')],
  ])]]));
  assert.equal(await (await ask(handlers, navigation(scope + 'page.html?x=1'))).text(), 'page');
});

test('не-навигационный запрос без копии — ошибка, а не «./»', async () => {
  const { handlers } = worker(new Map([[current, new Map([[scope, new Response('home')]])]]));
  for (const url of [scope + 'missing.js', scope + 'missing.png?x=1']) {
    const response = await ask(handlers, new Request(url));
    assert.equal(response.type, 'error', url);
  }
});

test('навигация, когда и «./» нет в кэше — ошибка', async () => {
  const { handlers } = worker(new Map([
    [current, new Map()],
    ['other-app-v1', new Map([[scope, new Response('foreign')]])],
  ]));
  const response = await ask(handlers, navigation(scope + 'unknown'));
  assert.equal(response.type, 'error');
});

test('воркер не перехватывает чужие пути, origin и запросы записи', () => {
  const { handlers } = worker();
  for (const [url, method] of [
    ['https://example.test/other/private', 'GET'],
    ['https://example.test/pdf-scanner-evil/app.js', 'GET'],
    ['https://other.test/pdf-scanner/app.js', 'GET'],
    [scope + 'upload', 'POST'],
  ]) {
    handlers.get('fetch')({
      request: new Request(url, { method }),
      respondWith: () => assert.fail('Чужой запрос перехвачен: ' + url),
    });
  }
});
