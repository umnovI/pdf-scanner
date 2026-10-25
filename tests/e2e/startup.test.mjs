// Регрессия: если сохранённые страницы загружались дольше обычного (медленная
// база, слабый телефон), загрузка заканчивалась уже после того, как пользователь
// добавил фото и что-то сделал, и перезаписывала список: фото и действия пропадали.
// Нашлось в CI (медленная машина): терялось последнее перемещение и «Очистить».
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addSigs, fixture, launch, pageSigs, phone, slowDbOpen, startServer, waitPages } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const move = (page, n, dir) => page.locator('.page').nth(n - 1).locator(dir === 'left' ? '.left' : '.right').click();

test('регрессия: фото и перемещения сразу после запуска не теряются, пока загружаются сохранённые страницы', async () => {
  const { page, ctx } = await phone(browser);
  await slowDbOpen(ctx, 1500);
  await page.goto(server.url);
  // Сразу, не дожидаясь загрузки.
  await addSigs(page, [0, 1, 2, 3]);
  await move(page, 1, 'right'); await move(page, 2, 'right'); await move(page, 3, 'right');
  await move(page, 4, 'left');
  assert.deepEqual(await pageSigs(page), [1, 2, 0, 3]);
  // Загрузка точно закончилась — список не перезаписан.
  await page.waitForTimeout(2000);
  assert.deepEqual(await pageSigs(page), [1, 2, 0, 3]);
});

// Регрессия (ветка проектов): фото, выбранное до загрузки проекта, терялось с
// TypeError в addFiles (state.project ещё не задан).
test('регрессия: фото, выбранное до загрузки проекта, не теряется', async () => {
  const { page, ctx } = await phone(browser);
  await slowDbOpen(ctx, 1500); // проект грузится заметно дольше обычного
  await page.goto(server.url);
  // Сразу, не дожидаясь названия проекта в шапке.
  await page.setInputFiles('#in-gallery', fixture('white.jpg'));
  await waitPages(page, 1);
  assert.equal(await page.textContent('#project-name'), 'Проект 1');
});
