// Основной сценарий: фото → редактор → PDF, без ошибок в консоли.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addFromCamera, addFromGallery, editorDone, launch, makePdf, pageCount, parsePdf, phone, startServer } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

test('снимок камерой, фото из галереи и PDF из двух страниц', async () => {
  const { page, errors } = await phone(browser);
  await page.goto(server.url);
  await addFromCamera(page, 'white.jpg');
  await editorDone(page);
  await addFromGallery(page, ['landscape.jpg']);
  assert.equal(await pageCount(page), 2);

  const { buf, filename } = await makePdf(page);
  // название проекта + дата; кириллица в имени не теряется
  assert.match(filename, /^Проект 1 \d{4}-\d\d-\d\d \d\d-\d\d\.pdf$/);
  const pdf = parsePdf(buf);
  assert.deepEqual(pdf.errors, []);
  assert.equal(pdf.count, 2);
  assert.equal(pdf.pages.length, 2);
  assert.deepEqual(errors, []);
});
