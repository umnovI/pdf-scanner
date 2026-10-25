// Регрессия: фото, выбранное сразу после запуска (пока проект ещё загружается),
// терялось с TypeError в addFiles (state.project ещё не задан).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fixture, launch, phone, startServer, waitPages } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

test('регрессия: фото, выбранное до загрузки проекта, не теряется', async () => {
  const { page, ctx } = await phone(browser);
  // Замедляем открытие базы на 1,5 с — проект грузится заметно дольше обычного.
  await ctx.addInitScript(() => {
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (...args) {
      const req = open.apply(this, args);
      const handlers = {};
      for (const ev of ['success', 'upgradeneeded', 'error', 'blocked']) {
        Object.defineProperty(req, 'on' + ev, {
          configurable: true,
          set(fn) { handlers[ev] = fn; },
          get() { return handlers[ev]; },
        });
      }
      const fire = ev => e => setTimeout(() => handlers[ev]?.call(req, e), ev === 'success' ? 1500 : 0);
      req.addEventListener('upgradeneeded', e => handlers.upgradeneeded?.call(req, e)); // синхронно, иначе транзакция закроется
      req.addEventListener('success', fire('success'));
      req.addEventListener('error', fire('error'));
      req.addEventListener('blocked', fire('blocked'));
      return req;
    };
  });
  await page.goto(server.url);
  // Сразу, не дожидаясь названия проекта в шапке.
  await page.setInputFiles('#in-gallery', fixture('white.jpg'));
  await waitPages(page, 1);
  assert.equal(await page.textContent('#project-name'), 'Проект 1');
});
