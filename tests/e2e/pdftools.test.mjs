// «Объединить PDF» и «Сжать PDF» через интерфейс: меню «⋮» → окна, списки, результат, скачивание.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import {
  addFromGallery, addSigs, idbFailInit, launch, makePdf, menuAct, newProject, openApp, parsePdf, startServer, waitName,
} from '../helpers.mjs';
import { noisyJpegs } from '../browser-pdf.mjs';
import { mergePdfs } from '../../app/pdftools.js';
import {
  PdfDoc, assertValidPdf, fx, handPdf, imageInfo, imagePdf, manifest, pageGeom, pageMarks, pdfInput, tightImagePdf,
} from '../pdfutil.mjs';

let server, browser, bigPdf, bigImages, manyImages;
before(async () => {
  server = await startServer();
  browser = await launch();
  // Исходники для сжатия: шумные JPEG (в браузере), PDF собираем в Node.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(server.url + '__blank.html');
  const js = await noisyJpegs(page, Array.from({ length: 6 }, () => ({ w: 1100, h: 1500 })));
  await ctx.close();
  const items = js.map(j => ({ bytes: Buffer.from(j.b64, 'base64'), w: j.w, h: j.h }));
  bigImages = imagePdf(items.slice(0, 3));      // ≈ 4–5 МБ
  manyImages = imagePdf(items);                  // ≈ 9 МБ, до 50 КБ не сжать
  bigPdf = bigImages;
});
after(async () => { await browser?.close(); await server?.close(); });

const MiB = 1024 * 1024;
const toastText = page => page.textContent('#toast');
const visible = (page, sel) => page.locator(sel).isVisible();

async function downloadOf(page, selector) {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click(selector)]);
  return { name: dl.suggestedFilename(), bytes: new Uint8Array(fs.readFileSync(await dl.path())) };
}

// ---------- Объединение ----------

const openMerge = async page => {
  await menuAct(page, 'merge');
  await page.waitForSelector('#merge:not([hidden])');
};
/** Добавляет PDF-файлы и ждёт, пока индикатор погаснет. */
const addPdfs = async (page, files) => {
  await page.setInputFiles('#in-merge', files);
  await page.waitForSelector('#busy[hidden]', { state: 'attached', timeout: 30000 });
};
const mergeItems = page => page.locator('#merge-list .merge-item').evaluateAll(els => els.map(e => ({
  title: e.querySelector('.merge-title').textContent, meta: e.querySelector('.merge-meta').textContent,
  up: !e.querySelector('.merge-up').disabled, down: !e.querySelector('.merge-down').disabled,
})));
const mergeMake = async page => {
  await page.click('#merge-make');
  await page.waitForSelector('#merge-download:not([hidden])', { timeout: 60000 });
};

describe('объединение PDF: окно и список', () => {
  test('пункт меню открывает окно: пусто, «Объединить» недоступна, подсказка и название по умолчанию', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    assert.equal(await page.textContent('#merge-title'), 'Объединить PDF');
    assert.equal(await page.locator('#merge-make').isDisabled(), true);
    assert.equal(await visible(page, '#merge-empty'), true);
    assert.deepEqual(await mergeItems(page), []);
    assert.match(await page.inputValue('#merge-name'), /^Объединённый \d{2}\.\d{2}\.\d{4}$/);
    assert.equal(await visible(page, '#merge-result'), false);
    assert.equal(await page.locator('#menu').isHidden(), true, 'меню закрылось');
    // проектов со страницами нет: в списке только подсказка, выбор недоступен
    assert.equal(await page.locator('#merge-project').isDisabled(), true);
    assert.deepEqual(await page.locator('#merge-project option').allTextContents(), ['Выберите проект…']);
    assert.deepEqual(errors, []);
  });

  test('один файл — кнопка недоступна; два — доступна; число страниц и размер в строках', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('text')]);
    assert.deepEqual((await mergeItems(page)).map(i => i.title), ['text'], 'расширение .pdf убрано');
    assert.match((await mergeItems(page))[0].meta, /^PDF · 3 стр\. · \d+ КБ$/);
    assert.equal(await page.locator('#merge-make').isDisabled(), true);
    assert.equal(await visible(page, '#merge-empty'), true);
    await addPdfs(page, [pdfInput('hybrid')]);
    assert.equal(await page.locator('#merge-make').isDisabled(), false);
    assert.equal(await visible(page, '#merge-empty'), false);
    assert.deepEqual(errors, []);
  });

  test('несколько файлов за раз; ↑ и ↓ переставляют; на краях стрелки недоступны; ✕ убирает', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('text'), pdfInput('hybrid'), pdfInput('objstm')]);
    let items = await mergeItems(page);
    assert.deepEqual(items.map(i => i.title), ['text', 'hybrid', 'objstm']);
    assert.deepEqual(items.map(i => i.up), [false, true, true]);
    assert.deepEqual(items.map(i => i.down), [true, true, false]);

    await page.locator('.merge-item').nth(2).locator('.merge-up').click();
    assert.deepEqual((await mergeItems(page)).map(i => i.title), ['text', 'objstm', 'hybrid']);
    await page.locator('.merge-item').nth(0).locator('.merge-down').click();
    assert.deepEqual((await mergeItems(page)).map(i => i.title), ['objstm', 'text', 'hybrid']);
    await page.locator('.merge-item').nth(1).locator('.merge-del').click();
    assert.deepEqual((await mergeItems(page)).map(i => i.title), ['objstm', 'hybrid']);
    await page.locator('.merge-item').nth(0).locator('.merge-del').click();
    assert.equal(await page.locator('#merge-make').isDisabled(), true, 'остался один элемент');
    await page.locator('.merge-item').nth(0).locator('.merge-del').click();
    assert.deepEqual(await mergeItems(page), []);
    assert.equal(await visible(page, '#merge-empty'), true);
    assert.deepEqual(errors, []);
  });

  test('один и тот же файл можно добавить дважды; кириллица в имени файла', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('Договор №1 (копия)', fx('text')), pdfInput('Договор №1 (копия)', fx('text'))]);
    assert.deepEqual((await mergeItems(page)).map(i => i.title), ['Договор №1 (копия)', 'Договор №1 (копия)']);
    assert.equal(await page.locator('#merge-make').isDisabled(), false);
    assert.deepEqual(errors, []);
  });

  test('закрытие и повторное открытие: список и результат сброшены; клик по фону тоже закрывает', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('text'), pdfInput('objstm')]);
    await mergeMake(page);
    await page.click('#merge-close');
    assert.equal(await page.locator('#merge').isHidden(), true);
    await openMerge(page);
    assert.deepEqual(await mergeItems(page), []);
    assert.equal(await visible(page, '#merge-result'), false, 'старый «Готово: …» остался в окне');
    assert.equal(await visible(page, '#merge-download'), false, 'кнопка «Скачать» осталась, а файла уже нет');
    assert.equal(await visible(page, '#merge-make'), true, '«Объединить» не вернулась');
    await page.mouse.click(2, 2); // фон окна
    assert.equal(await page.locator('#merge').isHidden(), true);
    assert.deepEqual(errors, []);
  });

  test('отмена выбора файлов (пустой выбор) ничего не меняет', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('text')]);
    await page.setInputFiles('#in-merge', []);
    assert.deepEqual((await mergeItems(page)).map(i => i.title), ['text']);
    assert.equal(await page.locator('#busy').isHidden(), true);
    assert.deepEqual(errors, []);
  });
});

describe('объединение PDF: результат', () => {
  test('«Готово: N стр.», скачивание: имя файла, порядок страниц, размеры, корректный PDF', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('text'), pdfInput('incremental'), pdfInput('hybrid')]);
    await page.fill('#merge-name', 'Итог: «договор»/2.pdf');
    await mergeMake(page);
    assert.match(await page.textContent('#merge-result'), /^Готово: 7 стр\., \d+ КБ$/);
    assert.equal(await visible(page, '#merge-make'), false);
    assert.equal(await visible(page, '#merge-download'), true);
    const { name, bytes } = await downloadOf(page, '#merge-download');
    assert.equal(name, 'Итог_ «договор»_2.pdf', 'запрещённые символы заменены, .pdf не удвоен');
    assertValidPdf(bytes, assert);
    const doc = await PdfDoc.load(bytes);
    assert.deepEqual(await pageMarks(doc), ['TEXT-P1', 'TEXT-P2', 'TEXT-P3', 'TEXT-P1', 'TEXT-P2', 'TEXT-P3', 'HYB-P1']);
    assert.deepEqual((await Promise.all(doc.pageRefs.map(async p => (await pageGeom(doc, p)).rotate))), [0, 0, 0, 90, 0, 0, 0]);
    assert.match(Buffer.from(bytes).toString('latin1'), /\/Title </);
    assert.deepEqual(errors, []);
  });

  test('любое изменение списка или названия сбрасывает результат; «Объединить» снова доступна', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('text'), pdfInput('hybrid'), pdfInput('objstm')]);
    const steps = [
      ['перестановка', () => page.locator('.merge-item').nth(1).locator('.merge-up').click()],
      ['удаление', () => page.locator('.merge-item').nth(2).locator('.merge-del').click()],
      ['добавление файла', () => addPdfs(page, [pdfInput('link')])],
      ['изменение названия', () => page.fill('#merge-name', 'другое')],
    ];
    for (const [what, act] of steps) {
      await mergeMake(page);
      assert.equal(await visible(page, '#merge-result'), true, what);
      await act();
      assert.equal(await visible(page, '#merge-result'), false, `${what}: результат не сброшен`);
      assert.equal(await visible(page, '#merge-download'), false, `${what}: «Скачать» осталась`);
      assert.equal(await visible(page, '#merge-make'), true, `${what}: «Объединить» не вернулась`);
    }
    assert.deepEqual(errors, []);
  });

  test('после сброса новый результат собирается из актуального списка (а не старый файл)', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('text'), pdfInput('hybrid')]);
    await mergeMake(page);
    await page.locator('.merge-item').nth(1).locator('.merge-up').click();
    await mergeMake(page);
    const { bytes } = await downloadOf(page, '#merge-download');
    assert.deepEqual(await pageMarks(await PdfDoc.load(bytes)), ['HYB-P1', 'TEXT-P1', 'TEXT-P2', 'TEXT-P3']);
    assert.deepEqual(errors, []);
  });

  test('пустое название — берётся название по умолчанию (по проекту и дате), не «.pdf»', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('text'), pdfInput('hybrid')]);
    await page.fill('#merge-name', '   ');
    await mergeMake(page);
    const { name } = await downloadOf(page, '#merge-download');
    assert.match(name, /^Проект 1 \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.pdf$/);
    assert.deepEqual(errors, []);
  });

  test('10 файлов по 3 страницы: 30 страниц по порядку', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    const files = Array.from({ length: 10 }, (_, i) => pdfInput(`f${i}`, handPdf(Array.from({ length: 3 }, (_, k) => ({ text: `F${i}-P${k + 1}` })))));
    await addPdfs(page, files);
    assert.equal((await mergeItems(page)).length, 10);
    await mergeMake(page);
    assert.match(await page.textContent('#merge-result'), /^Готово: 30 стр\./);
    const { bytes } = await downloadOf(page, '#merge-download');
    const doc = await PdfDoc.load(bytes);
    assert.deepEqual(await pageMarks(doc), Array.from({ length: 30 }, (_, i) => `F${Math.floor(i / 3)}-P${(i % 3) + 1}`));
    assert.deepEqual(errors, []);
  });

  test('ссылки внутри файла после объединения ведут на скопированные страницы', async () => {
    const { page, errors } = await openApp(browser, server);
    await openMerge(page);
    await addPdfs(page, [pdfInput('hybrid'), pdfInput('link')]);
    await mergeMake(page);
    const { bytes } = await downloadOf(page, '#merge-download');
    const d = await PdfDoc.load(bytes);
    const annots = await d.get(d.pageRefs[1].dict.get('Annots'));
    const dest = await d.get(annots[0]);
    assert.equal(dest.get('Dest')[0].num, d.pageRefs[3].ref.num);
    assert.deepEqual(errors, []);
  });
});

describe('объединение PDF: ошибки', () => {
  test('зашифрованный файл и не-PDF: понятный тост с именем файла, остальные добавляются, список цел', async () => {
    const { page, errors } = await openApp(browser, server, { allowErrors: [/Failed to load resource|зашифр|не PDF|PdfError|Error/i] });
    await openMerge(page);
    await addPdfs(page, [pdfInput('secret', fx('encrypted')), pdfInput('text')]);
    assert.match(await toastText(page), /«secret\.pdf»: PDF защищён \(зашифрован\)/);
    assert.deepEqual((await mergeItems(page)).map(i => i.title), ['text']);
    await addPdfs(page, [{ name: 'заметки.pdf', mimeType: 'application/pdf', buffer: Buffer.from('просто текст') }]);
    assert.match(await toastText(page), /«заметки\.pdf»: Это не PDF-файл/);
    assert.deepEqual((await mergeItems(page)).map(i => i.title), ['text'], 'список не сломан');
    // окно остаётся рабочим: добавляем ещё и собираем
    await addPdfs(page, [pdfInput('hybrid')]);
    await mergeMake(page);
    assert.match(await page.textContent('#merge-result'), /^Готово: 4 стр\./);
    assert.equal(await page.locator('#busy').isHidden(), true);
    assert.ok(errors.every(e => /зашифр|не PDF|PdfError|Error|Failed/i.test(e)), `лишние ошибки: ${errors}`);
  });

  test('сломанный PDF (мусор после заголовка) показывает «не удалось», а не зависает', async () => {
    const { page } = await openApp(browser, server, { allowErrors: [/.*/] });
    await openMerge(page);
    await addPdfs(page, [{ name: 'битый.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Broken') }]);
    assert.match(await toastText(page), /«битый\.pdf»/);
    assert.deepEqual(await mergeItems(page), []);
    assert.equal(await page.locator('#busy').isHidden(), true);
  });
});

describe('объединение PDF: проекты сканера', () => {
  test('проект из списка добавляется, из выбора исчезает; результат: страницы проекта идут как A4 с картинками', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg', 'landscape.jpg']);
    await openMerge(page);
    assert.equal(await page.locator('#merge-project').isDisabled(), false);
    assert.deepEqual(await page.locator('#merge-project option').allTextContents(), ['Выберите проект…', 'Проект 1 (2 стр.)']);
    await page.selectOption('#merge-project', { label: 'Проект 1 (2 стр.)' });
    assert.deepEqual((await mergeItems(page)).map(i => [i.title, i.meta]), [['Проект 1', 'Проект · 2 стр.']]);
    assert.deepEqual(await page.locator('#merge-project option').allTextContents(), ['Выберите проект…'], 'уже добавленного проекта в выборе нет');
    assert.equal(await page.locator('#merge-project').isDisabled(), true);
    await addPdfs(page, [pdfInput('text')]);
    await mergeMake(page);
    assert.match(await page.textContent('#merge-result'), /^Готово: 5 стр\./);
    const { bytes } = await downloadOf(page, '#merge-download');
    assertValidPdf(bytes, assert);
    const doc = await PdfDoc.load(bytes);
    assert.equal(doc.pageRefs.length, 5);
    assert.deepEqual((await pageMarks(doc)).slice(2), ['TEXT-P1', 'TEXT-P2', 'TEXT-P3'], 'страницы PDF-файла идут после проекта');
    const boxes = [];
    for (const p of doc.pageRefs.slice(0, 2)) boxes.push((await pageGeom(doc, p)).box.map(x => Math.round(x * 100) / 100));
    assert.deepEqual(boxes, [[0, 0, 595.28, 841.89], [0, 0, 595.28, 841.89]]);
    const imgs = await imageInfo(doc);
    assert.ok(imgs.slice(0, 2).every(i => i.filter === 'DCTDecode'), 'страницы проекта — JPEG-картинки');
    assert.deepEqual(errors, []);
  });

  test('сохранённые настройки экспорта (Letter, поля, «вписать») применяются к проекту', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg']);
    const own = await makePdf(page, { size: 'letter', fit: 'fit', margin: 36, quality: 'low' });
    const ownPdf = parsePdf(own.buf);
    assert.deepEqual(ownPdf.pages[0], [0, 0, 612, 792]);
    await openMerge(page);
    await page.selectOption('#merge-project', { index: 1 });
    await addPdfs(page, [pdfInput('hybrid')]);
    await mergeMake(page);
    const { bytes } = await downloadOf(page, '#merge-download');
    const doc = await PdfDoc.load(bytes);
    assert.deepEqual((await pageGeom(doc, doc.pageRefs[0])).box, [0, 0, 612, 792], 'Letter');
    // поле 36 pt и режим «вписать»: картинка не на весь лист
    const content = Buffer.from(await (async () => { const c = await doc.get(doc.pageRefs[0].dict.get('Contents')); return doc.decode(c); })()).toString('latin1');
    const m = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(content);
    assert.ok(m, content);
    assert.ok(+m[3] >= 36 - 0.01 && +m[4] >= 36 - 0.01, `поля меньше 36: ${m[3]}, ${m[4]}`);
    assert.ok(+m[1] <= 612 - 72 + 0.01 && +m[2] <= 792 - 72 + 0.01, 'картинка не вписана в поля');
    assert.deepEqual(errors, []);
  });

  test('другой (не открытый) проект берётся из базы; пустые проекты в выборе не предлагаются', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg', 'landscape.jpg', 'warm.jpg']);
    await newProject(page);
    await waitName(page, 'Проект 2');
    await newProject(page);
    await waitName(page, 'Проект 3');
    await addFromGallery(page, ['yellow.jpg']);
    await openMerge(page);
    assert.deepEqual(await page.locator('#merge-project option').allTextContents(), ['Выберите проект…', 'Проект 3 (1 стр.)', 'Проект 1 (3 стр.)'], 'проект 2 пуст');
    await page.selectOption('#merge-project', { label: 'Проект 1 (3 стр.)' });
    await page.selectOption('#merge-project', { label: 'Проект 3 (1 стр.)' });
    assert.deepEqual((await mergeItems(page)).map(i => i.title), ['Проект 1', 'Проект 3']);
    await mergeMake(page);
    assert.match(await page.textContent('#merge-result'), /^Готово: 4 стр\./);
    assert.deepEqual(errors, []);
  });

  test('проект + проект + PDF, затем перестановка: порядок страниц результата следует за списком', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg']);
    await newProject(page);
    await waitName(page, 'Проект 2');
    await addFromGallery(page, ['landscape.jpg', 'warm.jpg']);
    await openMerge(page);
    await page.selectOption('#merge-project', { label: 'Проект 2 (2 стр.)' });
    await page.selectOption('#merge-project', { label: 'Проект 1 (1 стр.)' });
    await addPdfs(page, [pdfInput('hybrid')]);
    await page.locator('.merge-item').nth(2).locator('.merge-up').click();
    await page.locator('.merge-item').nth(1).locator('.merge-up').click();
    const titles = (await mergeItems(page)).map(i => i.title);
    assert.deepEqual(titles, ['hybrid', 'Проект 2', 'Проект 1']);
    await mergeMake(page);
    const { bytes } = await downloadOf(page, '#merge-download');
    const doc = await PdfDoc.load(bytes);
    assert.equal(doc.pageRefs.length, 4);
    assert.equal((await pageMarks(doc))[0], 'HYB-P1');
    assert.deepEqual(errors, []);
  });

  test('удаление проекта (или очистка) невозможно из открытого окна, а добавленный проект после «Закрыть» не остаётся', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg']);
    await openMerge(page);
    await page.selectOption('#merge-project', { index: 1 });
    await page.click('#merge-close');
    await openMerge(page);
    assert.deepEqual(await mergeItems(page), []);
    assert.deepEqual(await page.locator('#merge-project option').allTextContents(), ['Выберите проект…', 'Проект 1 (1 стр.)']);
    assert.deepEqual(errors, []);
  });
});

describe('объединение PDF: особые случаи с проектами', () => {
  test('убранный из списка проект снова появляется в выборе', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg']);
    await openMerge(page);
    await page.selectOption('#merge-project', { index: 1 });
    await page.locator('.merge-item .merge-del').click();
    assert.deepEqual(await page.locator('#merge-project option').allTextContents(), ['Выберите проект…', 'Проект 1 (1 стр.)']);
    assert.deepEqual(errors, []);
  });

  test('проект с несохранёнными страницами (сбой записи в IndexedDB) объединяется целиком, число страниц в списке верное', async () => {
    const { page, errors } = await openApp(browser, server, { init: [idbFailInit] });
    await addSigs(page, [0]);                                          // сохранена
    await page.evaluate(() => { window.__idbFail = { put: 'throw' }; });
    await addSigs(page, [1]);                                          // только в памяти
    await page.evaluate(() => { window.__idbFail = {}; });
    await newProject(page);
    await waitName(page, 'Проект 2');
    await addSigs(page, [2]);
    await openMerge(page);
    await page.selectOption('#merge-project', { label: 'Проект 1 (2 стр.)' }).catch(() => {});
    const opts = await page.locator('#merge-project option').allTextContents();
    const item = (await mergeItems(page))[0];
    assert.ok(item, `проект 1 не добавился; варианты: ${opts}`);
    await addPdfs(page, [pdfInput('hybrid')]);
    await mergeMake(page);
    assert.match(await page.textContent('#merge-result'), /^Готово: 3 стр\./, `в списке было «${item.meta}»`);
    assert.deepEqual(errors, []);
  });
});

describe('«Поделиться»', () => {
  const shareStub = () => {
    window.__shared = [];
    navigator.canShare = () => true;
    navigator.share = async data => {
      if (window.__shareError) { const e = new Error('x'); e.name = window.__shareError; throw e; }
      window.__shared.push({ files: data.files.map(f => [f.name, f.type, f.size]), title: data.title });
    };
  };

  test('объединение: кнопка «Поделиться» отправляет файл с нужным именем; отмена не даёт тоста, сбой — даёт', async () => {
    const { page, errors } = await openApp(browser, server, { init: [shareStub] });
    await openMerge(page);
    await addPdfs(page, [pdfInput('text'), pdfInput('hybrid')]);
    await page.fill('#merge-name', 'Общий файл');
    await mergeMake(page);
    assert.equal(await visible(page, '#merge-share'), true);
    await page.click('#merge-share');
    await page.waitForFunction(() => window.__shared.length === 1);
    const [shared] = await page.evaluate(() => window.__shared);
    assert.equal(shared.files[0][0], 'Общий файл.pdf');
    assert.equal(shared.files[0][1], 'application/pdf');
    assert.ok(shared.files[0][2] > 1000);
    await page.evaluate(() => { window.__shareError = 'AbortError'; });
    await page.click('#merge-share');
    await page.evaluate(() => { document.getElementById('toast').hidden = true; });
    await page.click('#merge-share');
    assert.equal(await page.locator('#toast').isHidden(), true, 'отмена — не ошибка');
    await page.evaluate(() => { window.__shareError = 'NotAllowedError'; });
    await page.click('#merge-share');
    await page.waitForSelector('#toast:not([hidden])');
    assert.match(await toastText(page), /Не получилось поделиться/);
    assert.deepEqual(errors, []);
  });

  test('сжатие: «Поделиться» отправляет «имя (сжатый).pdf»', async () => {
    const { page, errors } = await openApp(browser, server, { init: [shareStub] });
    await openCompress(page);
    await pickBig(page, bigPdf, 'отчёт.pdf');
    await page.selectOption('#compress-target', '2');
    await compressMake(page);
    await page.click('#compress-share');
    await page.waitForFunction(() => window.__shared.length === 1);
    const [shared] = await page.evaluate(() => window.__shared);
    assert.equal(shared.files[0][0], 'отчёт (сжатый).pdf');
    assert.ok(shared.files[0][2] <= 2 * MiB);
    assert.deepEqual(errors, []);
  });

  test('регрессия: «Сохранить PDF» → «Поделиться» и «Скачать» по-прежнему отдают именно этот PDF', async () => {
    const { page, errors } = await openApp(browser, server, { init: [shareStub] });
    await addFromGallery(page, ['white.jpg', 'landscape.jpg']);
    await page.click('#btn-pdf');
    await page.fill('#pdf-name', 'Мой скан');
    await page.click('#pdf-make');
    await page.waitForSelector('#pdf-download:not([hidden])');
    assert.match(await page.textContent('#pdf-result'), /^Готово: 2 стр\., /);
    await page.click('#pdf-share');
    await page.waitForFunction(() => window.__shared.length === 1);
    const [shared] = await page.evaluate(() => window.__shared);
    assert.equal(shared.files[0][0], 'Мой скан.pdf');
    assert.equal(shared.title, 'Мой скан');
    const { name, bytes } = await downloadOf(page, '#pdf-download');
    assert.equal(name, 'Мой скан.pdf');
    assert.equal(bytes.length, shared.files[0][2], 'скачивается тот же файл, что и отправляется');
    assert.deepEqual(parsePdf(Buffer.from(bytes)).errors, []);
    assert.deepEqual(errors, []);
  });
});

// ---------- Сжатие ----------

const openCompress = async page => {
  await menuAct(page, 'compress');
  await page.waitForSelector('#compress:not([hidden])');
};
const pickBig = (page, bytes = bigPdf, name = 'Скан договора.pdf') => page.setInputFiles('#in-compress', pdfInput(name, bytes));
const compressMake = async (page, selector = '#compress-download') => {
  await page.click('#compress-make');
  await page.waitForSelector(`${selector}:not([hidden]), #compress-result:not([hidden])`, { timeout: 90000 });
  await page.waitForSelector('#busy[hidden]', { state: 'attached', timeout: 90000 });
};

describe('сжатие PDF', () => {
  test('окно: файл не выбран — «Сжать» недоступна; цель по умолчанию 2 МБ; «Свой размер» показывает поле', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    assert.equal(await page.locator('#compress-make').isDisabled(), true);
    assert.equal(await visible(page, '#compress-file'), false);
    assert.equal(await page.inputValue('#compress-target'), '2');
    assert.equal(await visible(page, '#compress-custom-field'), false);
    assert.deepEqual(await page.locator('#compress-target option').allTextContents(), ['1 МБ', '2 МБ', '5 МБ', '10 МБ', 'Свой размер…']);
    await page.selectOption('#compress-target', 'custom');
    assert.equal(await visible(page, '#compress-custom-field'), true);
    assert.equal(await page.inputValue('#compress-custom'), '3');
    await page.selectOption('#compress-target', '5');
    assert.equal(await visible(page, '#compress-custom-field'), false);
    assert.deepEqual(errors, []);
  });

  test('выбор файла: имя (кириллица) и размер в строке, кнопка доступна; пустой выбор ничего не ломает', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await pickBig(page);
    assert.match(await page.textContent('#compress-file'), /^Скан договора\.pdf · \d+\.\d МБ$/);
    assert.equal(await page.locator('#compress-make').isDisabled(), false);
    await page.setInputFiles('#in-compress', []);
    assert.match(await page.textContent('#compress-file'), /^Скан договора\.pdf/, 'прежний выбор остался');
    assert.deepEqual(errors, []);
  });

  test('цель 1 МБ: «Готово: A → B», скачивание «имя (сжатый).pdf», размер ≤ 1 МБ, страницы и текст целы', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await pickBig(page);
    await page.selectOption('#compress-target', '1');
    await compressMake(page);
    const text = await page.textContent('#compress-result');
    assert.match(text, /^Готово: \d+\.\d МБ → \d+(\.\d МБ| КБ)$/);
    assert.doesNotMatch(text, /без потери качества/);
    assert.equal(await visible(page, '#compress-make'), false);
    const { name, bytes } = await downloadOf(page, '#compress-download');
    assert.equal(name, 'Скан договора (сжатый).pdf');
    assert.ok(bytes.length <= 1 * MiB, `${bytes.length} > 1 МиБ`);
    assert.ok(bytes.length < bigPdf.length);
    assertValidPdf(bytes, assert);
    const doc = await PdfDoc.load(bytes);
    assert.deepEqual(await pageMarks(doc), ['BIG-P1', 'BIG-P2', 'BIG-P3']);
    assert.deepEqual(errors, []);
  });

  test('цель выше размера «без потерь»: сообщение «без потери качества», картинки те же', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await pickBig(page); // ≈ 6,3 МБ с ASCII85, без него ≈ 5 МБ
    await page.selectOption('#compress-target', '10');
    // файл < 10 МБ → «сжимать не нужно»; чтобы проверить ветку без потерь, берём цель между размерами
    await page.selectOption('#compress-target', 'custom');
    const lossless = Math.round((bigPdf.length * 0.8) / MiB * 100) / 100 + 0.2;
    await page.fill('#compress-custom', String(Math.min(lossless, bigPdf.length / MiB - 0.01)));
    await compressMake(page);
    assert.match(await page.textContent('#compress-result'), /^Готово: .* → .* \(без потери качества\)$/);
    assert.deepEqual(errors, []);
  });

  test('файл уже меньше цели: «сжимать не нужно», кнопки «Скачать» нет', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await page.setInputFiles('#in-compress', pdfInput('text'));
    await page.selectOption('#compress-target', '1');
    await page.click('#compress-make');
    await page.waitForSelector('#compress-result:not([hidden])');
    assert.match(await page.textContent('#compress-result'), /^Файл уже меньше 1\.0 МБ \(\d+ КБ\) — сжимать не нужно\.$/);
    assert.equal(await visible(page, '#compress-download'), false);
    assert.equal(await visible(page, '#compress-make'), true, 'можно выбрать другую цель');
    assert.equal(await page.locator('#busy').isHidden(), true);
    assert.deepEqual(errors, []);
  });

  test('недостижимая цель: понятное сообщение, но самый маленький вариант можно скачать', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await pickBig(page, manyImages, 'много.pdf');
    await page.selectOption('#compress-target', 'custom');
    await page.fill('#compress-custom', '0.05');
    await compressMake(page);
    assert.match(await page.textContent('#compress-result'), /^Уложиться в 51 КБ не получилось: меньше \d+ КБ не сжать \(\d+\.\d МБ → \d+ КБ\)/);
    const { name, bytes } = await downloadOf(page, '#compress-download');
    assert.equal(name, 'много (сжатый).pdf');
    assert.ok(bytes.length > 50 * 1024 && bytes.length < manyImages.length);
    assert.equal((await PdfDoc.load(bytes)).pageRefs.length, 6);
    assert.deepEqual(errors, []);
  });

  test('PDF без картинок, который не сжимается: «нет картинок», скачать нечего', async () => {
    const { page, errors } = await openApp(browser, server);
    // страницы уже плотно упакованы: случайные несжимаемые потоки
    const rnd = (n, seed) => { const b = Buffer.alloc(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; b[i] = s >>> 24; } return b; };
    const zlib = await import('node:zlib');
    const pages = Array.from({ length: 40 }, (_, i) => ({ content: zlib.deflateSync(rnd(1600, i + 1)).toString('latin1'), box: [0, 0, 300, 300] }));
    const raw = handPdf(pages.map(p => ({ ...p, content: p.content })), {});
    const bytes = Buffer.from(raw);
    // дописываем /Filter /FlateDecode к потокам содержимого — как в настоящих файлах
    const s = bytes.toString('latin1').replace(/(\d+ 0 obj\n<< )(\/Length \d+ >>\nstream)/g, '$1/Filter /FlateDecode $2');
    await openCompress(page);
    await page.setInputFiles('#in-compress', pdfInput('текст', new Uint8Array(Buffer.from(s, 'latin1'))));
    await page.selectOption('#compress-target', 'custom');
    await page.fill('#compress-custom', '0.05');
    await page.click('#compress-make');
    await page.waitForSelector('#compress-result:not([hidden])', { timeout: 30000 });
    await page.waitForSelector('#busy[hidden]', { state: 'attached' });
    assert.match(await page.textContent('#compress-result'), /нет картинок/);
    assert.deepEqual(errors, []);
  });

  test('картинки есть, но уже сжаты сильнее, чем умеет приложение: «уже сжаты», а не «нет картинок»', async () => {
    const { page, errors } = await openApp(browser, server);
    // три страницы по 32 КБ — больше минимальной цели 0,05 МБ
    const three = new Uint8Array(await (await mergePdfs([fx('compressed'), fx('compressed'), fx('compressed')])).blob.arrayBuffer());
    assert.ok(three.length > 60000);
    await openCompress(page);
    await page.setInputFiles('#in-compress', pdfInput('сжатый', three));
    await page.selectOption('#compress-target', 'custom');
    await page.fill('#compress-custom', '0.05');
    await compressMake(page);
    const text = await page.textContent('#compress-result');
    assert.match(text, /^Сжать не получилось: картинки в файле уже сжаты сильнее/);
    assert.doesNotMatch(text, /нет картинок/);
    assert.equal(await visible(page, '#compress-download'), false, 'скачивать нечего: файл не стал меньше');
    assert.deepEqual(errors, []);
  });

  test('картинки есть, «без потерь» получается даже больше исходного: то же сообщение, «Скачать» нет', async () => {
    const { page, errors } = await openApp(browser, server);
    const raw = (await imageInfo(await PdfDoc.load(fx('compressed'))))[0].raw;
    const pdf = await tightImagePdf(raw, 500, 500, 3);
    await openCompress(page);
    await page.setInputFiles('#in-compress', pdfInput('плотный', pdf));
    await page.selectOption('#compress-target', 'custom');
    await page.fill('#compress-custom', '0.05');
    await compressMake(page);
    assert.match(await page.textContent('#compress-result'), /^Сжать не получилось: картинки в файле уже сжаты сильнее/);
    assert.equal(await visible(page, '#compress-download'), false);
    assert.equal(await visible(page, '#compress-make'), true);
    assert.deepEqual(errors, []);
  });

  test('свой размер: «1,5» с запятой (как на телефоне с русской клавиатурой) и «1.5» с точкой дают цель 1,5 МБ', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await pickBig(page);
    await page.selectOption('#compress-target', 'custom');
    // Chrome на компьютере выкидывает запятую из number-поля («1,5» → «15»), на телефоне с русской
    // раскладкой запятая — десятичный разделитель. Чтобы проверить разбор приложения, значение задаём как текст.
    for (const v of ['1,5', '1.5']) {
      await page.evaluate(val => { const el = document.getElementById('compress-custom'); el.type = 'text'; el.value = val; el.dispatchEvent(new Event('input')); }, v);
      await compressMake(page);
      assert.match(await page.textContent('#compress-result'), /^Готово: /, v);
      const { bytes } = await downloadOf(page, '#compress-download');
      assert.ok(bytes.length <= 1.5 * MiB, `${v}: ${bytes.length} > 1,5 МиБ`);
      assert.ok(bytes.length > 1.0 * MiB, `${v}: ${bytes.length} — сжато сильнее, чем нужно для 1,5 МБ (цель понята как меньшая)`);
    }
    assert.deepEqual(errors, []);
  });

  test('неверный размер (пусто, 0, меньше 0,05, минус): тост «Укажите размер», ничего не сжимается', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await pickBig(page);
    await page.selectOption('#compress-target', 'custom');
    for (const v of ['', '0', '0.01', '-3']) {
      await page.fill('#compress-custom', v);
      await page.evaluate(() => { document.getElementById('toast').hidden = true; });
      await page.click('#compress-make');
      await page.waitForSelector('#toast:not([hidden])');
      assert.equal(await toastText(page), 'Укажите размер в мегабайтах', `значение «${v}»`);
      assert.equal(await page.locator('#busy').isHidden(), true);
      assert.equal(await visible(page, '#compress-result'), false);
    }
    assert.deepEqual(errors, []);
  });

  test('зашифрованный PDF больше цели: тост «зашифрован»; потом выбор другого файла работает', async () => {
    const { page, errors } = await openApp(browser, server, { allowErrors: [/.*/] });
    await openCompress(page);
    // дополняем зашифрованный файл мусором в конце, чтобы он был больше цели 0,05 МБ
    const enc = Buffer.concat([Buffer.from(fx('encrypted')), Buffer.alloc(60 * 1024, 32)]);
    await page.setInputFiles('#in-compress', pdfInput('secret', enc));
    await page.selectOption('#compress-target', 'custom');
    await page.fill('#compress-custom', '0.05');
    await page.click('#compress-make');
    await page.waitForSelector('#toast:not([hidden])');
    assert.match(await toastText(page), /зашифр/);
    assert.equal(await page.locator('#busy').isHidden(), true);
    await page.setInputFiles('#in-compress', { name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(60 * 1024, 65) });
    await page.evaluate(() => { document.getElementById('toast').hidden = true; });
    await page.click('#compress-make');
    await page.waitForSelector('#toast:not([hidden])');
    assert.match(await toastText(page), /не PDF/);
  });

  test('смена цели, пользовательского значения или файла сбрасывает результат', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await pickBig(page);
    await page.selectOption('#compress-target', '5');
    for (const [what, act] of [
      ['цель', () => page.selectOption('#compress-target', '2')],
      ['свой размер', async () => { await page.selectOption('#compress-target', 'custom'); await page.fill('#compress-custom', '2'); }],
      ['другой файл', () => pickBig(page, bigPdf, 'другой.pdf')],
    ]) {
      await compressMake(page);
      assert.equal(await visible(page, '#compress-result'), true, what);
      await act();
      assert.equal(await visible(page, '#compress-result'), false, `${what}: результат остался`);
      assert.equal(await visible(page, '#compress-download'), false, `${what}: «Скачать» осталась`);
      assert.equal(await visible(page, '#compress-make'), true);
      if (what === 'свой размер') await page.selectOption('#compress-target', '5');
    }
    assert.deepEqual(errors, []);
  });

  test('цель запоминается между открытиями и перезапуском', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await pickBig(page);
    await page.selectOption('#compress-target', 'custom');
    await page.fill('#compress-custom', '7.5');
    await page.click('#compress-make'); // файл меньше цели — быстро
    await page.waitForSelector('#compress-result:not([hidden])');
    await page.click('#compress-close');
    await openCompress(page);
    assert.equal(await page.inputValue('#compress-target'), 'custom');
    assert.equal(await page.inputValue('#compress-custom'), '7.5');
    assert.equal(await visible(page, '#compress-file'), false, 'файл не запоминается');
    assert.equal(await page.locator('#compress-make').isDisabled(), true);
    await page.reload();
    await openCompress(page);
    assert.equal(await page.inputValue('#compress-custom'), '7.5');
    assert.deepEqual(errors, []);
  });

  test('закрытие по фону; повторное открытие — чистое окно', async () => {
    const { page, errors } = await openApp(browser, server);
    await openCompress(page);
    await pickBig(page);
    await page.mouse.click(2, 2);
    assert.equal(await page.locator('#compress').isHidden(), true);
    await openCompress(page);
    assert.equal(await visible(page, '#compress-file'), false);
    assert.deepEqual(errors, []);
  });
});

describe('общее: обновление, офлайн, экспорт', () => {
  test('регрессия: обычный экспорт «Сохранить PDF» (Letter, «вписать», поля, качество) работает как раньше', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg', 'landscape.jpg', 'warm.jpg']);
    const { buf, filename } = await makePdf(page, { size: 'letter', fit: 'fit', margin: 18, quality: 'medium' });
    const r = parsePdf(buf);
    assert.deepEqual(r.errors, []);
    assert.equal(r.count, 3);
    assert.deepEqual(r.pages, [[0, 0, 612, 792], [0, 0, 612, 792], [0, 0, 612, 792]]);
    assert.equal(r.images.length, 3);
    assert.match(filename, /^Проект 1 \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.pdf$/);
    assert.deepEqual(errors, []);
  });
});
