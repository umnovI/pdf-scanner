// Съёмка и редактор страницы: камера, «Готово», «Снять ещё», «Отмена», «Переснять», запоминание фильтра.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  activeFilter, addFromCamera, addFromGallery, addSigs, cornerError, dbRecords, editorDone, launch, openApp,
  openEditor, pageCount, pageRatios, pick, settle, startServer, truth, waitPages,
} from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const px = (corners, [w, h] = [1000, 1250]) => corners.map(([x, y]) => [x * w, y * h]);

describe('камера и редактор', () => {
  test('снимок → редактор с найденной рамкой → «Готово»', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    assert.equal(await page.textContent('#ed-title'), 'Страница 1');
    assert.equal(await page.locator('#ed-more').isVisible(), true, 'у новой страницы есть «Готово и снять ещё страницу»');
    assert.equal(await activeFilter(page), 'enhance', 'по умолчанию «Улучшить»');
    await editorDone(page);
    assert.equal(await pageCount(page), 1);
    assert.equal(await page.locator('#btn-pdf').textContent().then(t => t.trim()), 'PDF (1)'); // иконка — SVG, без текста

    // рамка действительно найдена, а не «весь кадр»
    const [rec] = await dbRecords(page);
    assert.ok(cornerError(px(rec.corners), truth['white.jpg']) <= 25, JSON.stringify(rec.corners));
    assert.deepEqual(errors, []);
  });

  test('рамка в редакторе совпадает с найденной: ручки стоят на углах листа', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    // ручки должны образовать выпуклый четырёхугольник внутри холста, а не рамку по краям кадра
    const r = await page.evaluate(() => {
      const stage = document.getElementById('ed-stage').getBoundingClientRect();
      const hs = [...document.querySelectorAll('.handle')].map(h => { const b = h.getBoundingClientRect(); return [b.x + b.width / 2 - stage.x, b.y + b.height / 2 - stage.y]; });
      const c = document.getElementById('ed-canvas').getBoundingClientRect();
      return { hs, w: c.width, h: c.height };
    });
    const [tl, tr, br, bl] = r.hs;
    assert.ok(tl[0] < tr[0] && bl[0] < br[0] && tl[1] < bl[1] && tr[1] < br[1]);
    // кадр 4:5, лист занимает примерно 65% ширины: рамка заметно у́же холста
    assert.ok(tr[0] - tl[0] < r.w * 0.9);
  });

  test('«Готово и снять ещё страницу»: страница сохраняется, камера открывается сразу, потом новый редактор', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    // камера должна открыться по тому же нажатию (иначе браузер её заблокирует)
    await pick(page, '#ed-more', 'yellow.jpg');
    await page.waitForSelector('#editor:not([hidden])');
    await waitPages(page, 2);
    assert.equal(await page.textContent('#ed-title'), 'Страница 2');
    assert.equal(await pageCount(page), 2);
    await editorDone(page);
    assert.equal((await dbRecords(page)).length, 2);
    assert.deepEqual(errors, []);
  });

  test('«Готово и снять ещё» сохраняет и правки текущей страницы', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    await page.click('#ed-filters [data-f="bw"]');
    await page.click('#ed-rotr');
    await pick(page, '#ed-more', 'school.jpg');
    await page.waitForSelector('#editor:not([hidden])');
    await waitPages(page, 2);
    const [first] = await dbRecords(page);
    assert.equal(first.filter, 'bw');
    assert.equal(first.rotation, 90);
  });

  test('«Отмена» в редакторе существующей страницы ничего не меняет', async () => {
    const { page } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg', 'school.jpg']);
    const recBefore = await dbRecords(page);
    const thumbBefore = await page.locator('.page img').first().getAttribute('src');
    await openEditor(page, 1);
    await page.click('#ed-rotr');
    await page.click('#ed-filters [data-f="bw"]');
    await page.click('#ed-full');
    await page.click('#ed-cancel');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    assert.equal(await pageCount(page), 2);
    assert.deepEqual(await dbRecords(page), recBefore);
    assert.equal(await page.locator('.page img').first().getAttribute('src'), thumbBefore, 'миниатюра не пересчитывалась');
    // «Отмена» не запоминает выбранный фильтр
    assert.equal(await page.evaluate(() => localStorage.getItem('ps.filter')), null);
  });

  test('«Отмена» сразу после съёмки оставляет страницу как есть, без правок', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    const recBefore = await dbRecords(page);
    await page.click('#ed-filters [data-f="doc"]');
    await page.click('#ed-cancel');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    assert.equal(await pageCount(page), 1);
    assert.deepEqual(await dbRecords(page), recBefore);
    assert.equal(recBefore[0].filter, 'enhance');
  });

  test('камера закрыта без снимка: ничего не добавляется', async () => {
    const { page, errors } = await openApp(browser, server);
    await page.setInputFiles('#in-camera', []);
    await page.dispatchEvent('#in-camera', 'cancel');
    await settle(page); // приложение успело бы открыть редактор или добавить страницу
    assert.equal(await pageCount(page), 0);
    assert.equal(await page.locator('#editor').isHidden(), true);
    assert.equal(await page.locator('#empty').isVisible(), true);
    // и после этого приложение работает: следующая страница из галереи — ровно одна, лишних нет
    await addFromGallery(page, ['white.jpg']);
    assert.equal(await pageCount(page), 1);
    assert.equal(await page.locator('#editor').isHidden(), true);
    assert.deepEqual(errors, []);
  });

  test('повернуть и «Готово»: поворот и рамка сохраняются', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    const [before] = await dbRecords(page);
    await page.click('#ed-rotr');
    await editorDone(page);
    const [after] = await dbRecords(page);
    assert.equal(after.rotation, 90);
    assert.notDeepEqual(after.corners, before.corners);
    // поворот влево возвращает как было
    await openEditor(page, 1);
    await page.click('#ed-rotl');
    await editorDone(page);
    const [back] = await dbRecords(page);
    assert.equal(back.rotation, 0);
    back.corners.forEach((p, i) => { assert.ok(Math.abs(p[0] - before.corners[i][0]) < 1e-6 && Math.abs(p[1] - before.corners[i][1]) < 1e-6); });
  });

  test('«Сброс» ставит рамку на весь кадр, «Края» находит лист снова', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    await page.click('#ed-full');
    await editorDone(page);
    assert.deepEqual((await dbRecords(page))[0].corners, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    await openEditor(page, 1);
    await page.click('#ed-auto');
    await editorDone(page);
    const [rec] = await dbRecords(page);
    assert.ok(cornerError(px(rec.corners), truth['white.jpg']) <= 25);
  });

  test('удаление из редактора (с подтверждением)', async () => {
    const { page } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg', 'school.jpg']);
    await openEditor(page, 1);
    page.once('dialog', d => d.dismiss());
    await page.click('#ed-delete');
    assert.equal(await page.locator('#editor').isVisible(), true, 'отказ в подтверждении оставляет редактор открытым');
    assert.equal(await pageCount(page), 2);
    page.once('dialog', d => d.accept());
    await page.click('#ed-delete');
    await page.waitForSelector('#editor[hidden]', { state: 'attached' });
    assert.equal(await pageCount(page), 1);
  });
});

describe('«Переснять»', () => {
  test('заменяет фото на том же месте, число страниц не меняется', async () => {
    const { page, errors } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    assert.deepEqual(await pageRatios(page), [1, 1.25, 1.5]);
    const idsBefore = (await dbRecords(page)).map(r => r.id);

    await openEditor(page, 2);
    assert.equal(await page.locator('#ed-more').isHidden(), true);
    await pick(page, '#ed-retake', 'landscape.jpg');
    await page.waitForSelector('#editor:not([hidden])');
    assert.equal(await page.textContent('#ed-title'), 'Страница 2');
    assert.equal(await page.locator('#ed-more').isVisible(), true, 'после переснимания можно снять следующую');

    assert.equal(await pageCount(page), 3);
    const ratios = await pageRatios(page);
    assert.equal(ratios[0], 1);
    assert.equal(ratios[2], 1.5);
    assert.notEqual(ratios[1], 1.25, 'вторая страница заменена новым фото');
    assert.deepEqual((await dbRecords(page)).map(r => r.id), idsBefore, 'те же страницы в том же порядке');
    await editorDone(page);
    assert.equal(await pageCount(page), 3);
    assert.deepEqual(errors, []);
  });

  test('после «Переснять» обычная «Камера» добавляет новую страницу', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1]);
    await openEditor(page, 1);
    await pick(page, '#ed-retake', 'white.jpg');
    await page.waitForSelector('#editor:not([hidden])');
    await editorDone(page);
    assert.equal(await pageCount(page), 2);

    await pick(page, '#btn-camera', 'yellow.jpg');
    await page.waitForSelector('#editor:not([hidden])');
    await waitPages(page, 3);
    assert.equal(await page.textContent('#ed-title'), 'Страница 3');
    await editorDone(page);
    assert.equal(await pageCount(page), 3);
  });

  test('«Переснять» и закрыть камеру без снимка: страница цела, следующий снимок — новая страница', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1]);
    const recs = await dbRecords(page);
    await openEditor(page, 2);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#ed-retake')]);
    void chooser;
    await page.dispatchEvent('#in-camera', 'cancel');
    await settle(page);
    assert.equal(await pageCount(page), 2);
    assert.deepEqual(await dbRecords(page), recs);
    assert.equal(await page.textContent('#ed-title'), 'Страница 2', 'редактор остался на той же странице');
    await pick(page, '#btn-camera', 'white.jpg');
    await page.waitForSelector('#editor:not([hidden])');
    await waitPages(page, 3);
    assert.equal(await page.textContent('#ed-title'), 'Страница 3');
    assert.deepEqual((await dbRecords(page)).slice(0, 2).map(r => r.id), recs.map(r => r.id));
  });

  test('фильтр страницы при переснимании сохраняется', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    await page.click('#ed-filters [data-f="gray"]');
    await editorDone(page);
    await openEditor(page, 1);
    await pick(page, '#ed-retake', 'yellow.jpg');
    await page.waitForSelector('#editor:not([hidden])');
    assert.equal(await activeFilter(page), 'gray');
    await editorDone(page);
    assert.equal((await dbRecords(page))[0].filter, 'gray');
  });

  test('переснятая страница переживает перезагрузку', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    await openEditor(page, 3);
    await pick(page, '#ed-retake', 'landscape.jpg');
    await page.waitForSelector('#editor:not([hidden])');
    await editorDone(page);
    const ratios = await pageRatios(page);
    await page.reload();
    await waitPages(page, 3);
    assert.deepEqual(await pageRatios(page), ratios);
  });
});

describe('запоминание фильтра', () => {
  test('выбрал «Документ» — следующий снимок тоже «Документ»', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    assert.equal(await activeFilter(page), 'enhance');
    await page.click('#ed-filters [data-f="doc"]');
    await editorDone(page);

    await addFromCamera(page, 'school.jpg');
    assert.equal(await activeFilter(page), 'doc');
    await editorDone(page);
    // и фото из галереи
    await addFromGallery(page, ['yellow.jpg']);
    assert.deepEqual((await dbRecords(page)).map(r => r.filter), ['doc', 'doc', 'doc']);
  });

  test('выбор фильтра переживает перезагрузку страницы', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    await page.click('#ed-filters [data-f="bw"]');
    await editorDone(page);
    await page.reload();
    await waitPages(page, 1);
    await addFromCamera(page, 'school.jpg');
    assert.equal(await activeFilter(page), 'bw');
  });

  test('смена фильтра у старой страницы тоже запоминается и применяется к следующим', async () => {
    const { page } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg']);
    await openEditor(page, 1);
    await page.click('#ed-filters [data-f="color"]');
    await editorDone(page);
    await addFromCamera(page, 'yellow.jpg');
    assert.equal(await activeFilter(page), 'color');
  });
});
