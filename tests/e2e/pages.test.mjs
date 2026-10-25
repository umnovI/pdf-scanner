// Список страниц (порядок, удаление, очистка, перезагрузка) и создание PDF.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  addFromCamera, addFromGallery, addSigs, dbRecords, editorDone, launch, makePdf, makePng, openApp, openEditor, pageCount,
  pageSigs, parsePdf, startServer, waitPages,
} from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const move = (page, n, dir) => page.locator('.page').nth(n - 1).locator(dir === 'left' ? '.left' : '.right').click();
async function remove(page, n, accept = true) {
  page.once('dialog', d => (accept ? d.accept() : d.dismiss()));
  await page.locator('.page').nth(n - 1).locator('.del').click();
}
async function reloadAndWait(page, n) {
  await page.reload();
  if (n) await waitPages(page, n); else await page.waitForSelector('#empty:not([hidden])');
}

describe('порядок страниц', () => {
  test('пустой список: подсказка, кнопки «PDF» и «Очистить» недоступны', async () => {
    const { page } = await openApp(browser, server);
    assert.equal(await page.locator('#empty').isVisible(), true);
    assert.equal(await page.locator('#btn-pdf').isDisabled(), true);
    assert.equal(await page.locator('#btn-clear').isHidden(), true);
  });

  test('◀ ▶ переставляют страницы, крайние кнопки отключены, порядок переживает перезагрузку', async () => {
    const { page, errors } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    assert.deepEqual(await pageSigs(page), [0, 1, 2]);
    assert.equal(await page.locator('.page').first().locator('.left').isDisabled(), true);
    assert.equal(await page.locator('.page').last().locator('.right').isDisabled(), true);

    await move(page, 1, 'right');
    assert.deepEqual(await pageSigs(page), [1, 0, 2]);
    await move(page, 3, 'left');
    assert.deepEqual(await pageSigs(page), [1, 2, 0]);
    assert.deepEqual(await page.locator('.num').allTextContents(), ['1', '2', '3']);

    await reloadAndWait(page, 3);
    assert.deepEqual(await pageSigs(page), [1, 2, 0]);
    assert.deepEqual(errors, []);
  });

  test('одна страница: перемещать некуда', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0]);
    assert.equal(await page.locator('.left').isDisabled(), true);
    assert.equal(await page.locator('.right').isDisabled(), true);
  });

  test('перемещение на месте несколько раз подряд: итоговый порядок верный и сохраняется', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2, 3]);
    await move(page, 1, 'right'); await move(page, 2, 'right'); await move(page, 3, 'right'); // 0 уезжает в конец
    await move(page, 4, 'left');
    assert.deepEqual(await pageSigs(page), [1, 2, 0, 3]);
    await reloadAndWait(page, 4);
    assert.deepEqual(await pageSigs(page), [1, 2, 0, 3]);
  });

  test('порядок в PDF совпадает с порядком на экране', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 3]);
    await move(page, 3, 'left');
    assert.deepEqual(await pageSigs(page), [0, 3, 1]);
    const { buf } = await makePdf(page);
    const pdf = parsePdf(buf);
    assert.deepEqual(pdf.images.map(i => Math.round((i.h / i.w - 1) * 4)), [0, 3, 1]);
  });
});

describe('удаление и очистка', () => {
  test('удаление с подтверждением; отказ ничего не удаляет; результат переживает перезагрузку', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    await remove(page, 1, false);
    assert.equal(await pageCount(page), 3);
    await remove(page, 1);
    await waitPages(page, 2);
    assert.deepEqual(await pageSigs(page), [1, 2]);
    assert.deepEqual(await page.locator('.num').allTextContents(), ['1', '2']);
    await reloadAndWait(page, 2);
    assert.deepEqual(await pageSigs(page), [1, 2]);
    assert.equal((await dbRecords(page)).length, 2);
  });

  test('удалена последняя страница: снова пустое состояние', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0]);
    await remove(page, 1);
    await page.waitForSelector('#empty:not([hidden])');
    assert.equal(await page.locator('#btn-pdf').isDisabled(), true);
    assert.equal(await page.locator('#btn-clear').isHidden(), true);
    await reloadAndWait(page, 0);
    assert.equal(await pageCount(page), 0);
  });

  test('«Очистить»: отказ оставляет всё, согласие удаляет всё, и после перезагрузки пусто', async () => {
    const { page, errors } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    page.once('dialog', d => { assert.match(d.message(), /Удалить все страницы/); d.dismiss(); });
    await page.click('#btn-clear');
    assert.equal(await pageCount(page), 3);

    page.once('dialog', d => d.accept());
    await page.click('#btn-clear');
    await page.waitForSelector('#empty:not([hidden])');
    assert.equal(await pageCount(page), 0);
    await reloadAndWait(page, 0);
    assert.equal(await pageCount(page), 0);
    assert.deepEqual(await dbRecords(page), []);

    // после очистки приложение работает как обычно
    await addSigs(page, [1]);
    await reloadAndWait(page, 1);
    assert.deepEqual(await pageSigs(page), [1]);
    assert.deepEqual(errors, []);
  });

  test('удалить первую и добавить новую: новая страница в конце, в том числе после перезагрузки', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    await remove(page, 1);
    await waitPages(page, 2);
    await addSigs(page, [3]);
    assert.deepEqual(await pageSigs(page), [1, 2, 3]);
    await reloadAndWait(page, 3);
    assert.deepEqual(await pageSigs(page), [1, 2, 3]);
  });

  test('много страниц: удалить из середины, переставить, перезагрузить', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2, 3, 4, 5]);
    await remove(page, 3);
    await waitPages(page, 5);
    await move(page, 5, 'left');
    await move(page, 1, 'right');
    const expected = await pageSigs(page);
    assert.deepEqual(expected, [1, 0, 3, 5, 4]);
    await reloadAndWait(page, 5);
    assert.deepEqual(await pageSigs(page), expected);
  });
});

describe('сохранение при правке', () => {
  test('правка страницы после перестановки не сбивает порядок', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    await move(page, 1, 'right');
    await openEditor(page, 1);
    await page.click('#ed-filters [data-f="gray"]');
    await editorDone(page);
    assert.deepEqual(await pageSigs(page), [1, 0, 2]);
    await reloadAndWait(page, 3);
    assert.deepEqual(await pageSigs(page), [1, 0, 2]);
    assert.deepEqual((await dbRecords(page)).map(r => r.filter), ['gray', 'enhance', 'enhance']);
  });

  test('страницы, поворот и фильтр переживают перезагрузку посреди работы (камера → закрыли вкладку)', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    await page.click('#ed-rotr');
    await page.click('#ed-filters [data-f="doc"]');
    await editorDone(page);
    await page.reload();
    await waitPages(page, 1);
    const [rec] = await dbRecords(page);
    assert.equal(rec.rotation, 90);
    assert.equal(rec.filter, 'doc');
  });
});

describe('PDF', () => {
  const MIXED = ['white.jpg', 'landscape.jpg', 'school.jpg'];

  test('имя файла по умолчанию: «Scan ГГГГ-ММ-ДД ЧЧ-ММ.pdf»', async () => {
    const { page } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg']);
    const { filename } = await makePdf(page);
    assert.match(filename, /^Scan \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.pdf$/);
  });

  test('своё имя (кириллица), недопустимые символы заменяются, «.pdf» не дублируется', async () => {
    const { page } = await openApp(browser, server);
    // Безголовый Chromium заменяет не-ASCII имена файлов на «download», поэтому смотрим на атрибут download ссылки.
    await page.evaluate(() => {
      const click = HTMLAnchorElement.prototype.click;
      window.downloads = [];
      HTMLAnchorElement.prototype.click = function () { window.downloads.push(this.download); return click.call(this); };
    });
    await addFromGallery(page, ['white.jpg']);
    const names = [['Договор №5 «Ёлка»', 'Договор №5 «Ёлка».pdf'], ['a/b:c*?d', 'a_b_c_d.pdf'], ['report.PDF', 'report.pdf'], ['   ', /^Scan \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.pdf$/]];
    for (const [typed, expected] of names) {
      await page.click('#btn-pdf');
      await page.fill('#pdf-name', typed);
      await page.click('#pdf-make');
      await page.waitForSelector('#pdf-download:not([hidden])');
      await page.click('#pdf-download');
      const got = await page.evaluate(() => window.downloads.at(-1));
      if (typeof expected === 'string') assert.equal(got, expected);
      else assert.match(got, expected);
      await page.click('#pdf-close');
    }
    assert.equal((await page.evaluate(() => window.downloads)).length, names.length);
  });

  test('число страниц, таблица xref и заголовок с именем файла', async () => {
    const { page, errors } = await openApp(browser, server);
    await addFromGallery(page, MIXED);
    await page.click('#btn-pdf');
    await page.fill('#pdf-name', 'Скан для налоговой');
    await page.click('#pdf-make');
    await page.waitForSelector('#pdf-download:not([hidden])');
    assert.match(await page.textContent('#pdf-result'), /^Готово: 3 стр\., \d+ (КБ|МБ)$/);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pdf-download')]);
    const buf = (await import('node:fs')).readFileSync(await dl.path());
    const pdf = parsePdf(buf);
    assert.deepEqual(pdf.errors, []);
    assert.equal(pdf.count, 3);
    assert.equal(pdf.pages.length, 3);
    const hex = /\/Title <([0-9A-F]+)>/.exec(buf.toString('latin1'))[1];
    assert.equal(Buffer.from(hex.slice(4), 'hex').swap16().toString('utf16le'), 'Скан для налоговой');
    assert.deepEqual(errors, []);
  });

  for (const size of ['a4', 'letter']) {
    for (const fit of ['fill', 'fit']) {
      test(`страницы PDF одного размера при вертикальных и горизонтальных фото: ${size}, ${fit}`, async () => {
        const { page } = await openApp(browser, server);
        await addFromGallery(page, MIXED);
        await addSigs(page, [4]); // узкая вертикальная
        const { buf } = await makePdf(page, { size, fit, margin: 18 });
        const pdf = parsePdf(buf);
        assert.deepEqual(pdf.errors, []);
        assert.equal(pdf.pages.length, 4);
        const want = size === 'a4' ? [0, 0, 595.28, 841.89] : [0, 0, 612, 792];
        for (const mb of pdf.pages) assert.deepEqual(mb, want);
      });
    }
  }

  test('качество «Сжатое» даёт файл меньше, чем «Высокое»', async () => {
    const { page } = await openApp(browser, server);
    await addFromGallery(page, ['school.jpg', 'white.jpg', 'yellow.jpg']);
    const high = (await makePdf(page, { quality: 'high' })).buf.length;
    const medium = (await makePdf(page, { quality: 'medium' })).buf.length;
    const low = (await makePdf(page, { quality: 'low' })).buf.length;
    assert.ok(low < high, `сжатое ${low} не меньше высокого ${high}`);
    assert.ok(medium <= high && low <= medium, `высокое ${high}, среднее ${medium}, сжатое ${low}`);
  });

  test('сжатие уменьшает и размеры картинок у больших фото', async () => {
    const { page } = await openApp(browser, server);
    // большое фото: 3000 px по длинной стороне
    await page.setInputFiles('#in-gallery', [{ name: 'big.png', mimeType: 'image/png', buffer: makePng(3000, 2000) }]);
    await waitPages(page, 1);
    const hi = parsePdf((await makePdf(page, { quality: 'high' })).buf).images[0];
    const lo = parsePdf((await makePdf(page, { quality: 'low' })).buf).images[0];
    assert.equal(Math.max(hi.w, hi.h), 2480);
    assert.equal(Math.max(lo.w, lo.h), 1300);
  });

  test('настройки PDF запоминаются; изменение настроек после создания сбрасывает результат', async () => {
    const { page } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg']);
    await makePdf(page, { size: 'letter', fit: 'fit', margin: 36, quality: 'low' });
    await page.click('#btn-pdf');
    assert.equal(await page.inputValue('#pdf-size'), 'letter');
    assert.equal(await page.inputValue('#pdf-fit'), 'fit');
    assert.equal(await page.inputValue('#pdf-margin'), '36');
    assert.equal(await page.inputValue('#pdf-quality'), 'low');
    assert.equal(await page.locator('#pdf-download').isHidden(), true, 'старый результат не показывается');
    await page.click('#pdf-make');
    await page.waitForSelector('#pdf-download:not([hidden])');
    await page.selectOption('#pdf-size', 'a4');
    assert.equal(await page.locator('#pdf-download').isHidden(), true);
    assert.equal(await page.locator('#pdf-make').isVisible(), true);
    await page.click('#pdf-close');
  });

  test('окно PDF закрывается кнопкой «Закрыть» и нажатием на фон; в нём видна версия', async () => {
    const { page } = await openApp(browser, server);
    await addFromGallery(page, ['white.jpg']);
    await page.click('#btn-pdf');
    assert.equal(await page.textContent('#version'), 'Версия: dev');
    await page.click('#pdf-close');
    assert.equal(await page.locator('#sheet').isHidden(), true);
    await page.click('#btn-pdf');
    await page.mouse.click(5, 5); // фон окна
    assert.equal(await page.locator('#sheet').isHidden(), true);
  });

  test('одна страница', async () => {
    const { page } = await openApp(browser, server);
    await addFromGallery(page, ['landscape.jpg']);
    const pdf = parsePdf((await makePdf(page)).buf);
    assert.deepEqual(pdf.errors, []);
    assert.equal(pdf.count, 1);
  });
});
