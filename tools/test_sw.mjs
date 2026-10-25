// Запуск: node --test tools/test_sw.mjs. Внешние зависимости не нужны.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../app/sw.js', import.meta.url), 'utf8');
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
      return { match: async request => stores.get(key).get(request.url) };
    },
    // Чтение из общего Cache Storage недопустимо даже при промахе своего кэша.
    match: () => { throw new Error('Чтение чужих кэшей'); },
  };
  vm.runInNewContext(source, {
    self, caches, URL, Request,
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
  assert.equal(await response, undefined);
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
