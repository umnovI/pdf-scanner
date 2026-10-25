// Регрессия: фото, выбранное сразу после запуска (пока проект ещё загружается),
// терялось с TypeError в addFiles (state.project ещё не задан).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fixture, launch, phone, slowDbOpen, startServer, waitPages } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

test('регрессия: фото, выбранное до загрузки проекта, не теряется', async () => {
  const { page, ctx } = await phone(browser);
  await slowDbOpen(ctx, 1500); // проект грузится заметно дольше обычного
  await page.goto(server.url);
  // Сразу, не дожидаясь названия проекта в шапке.
  await page.setInputFiles('#in-gallery', fixture('white.jpg'));
  await waitPages(page, 1);
  assert.equal(await page.textContent('#project-name'), 'Проект 1');
});
