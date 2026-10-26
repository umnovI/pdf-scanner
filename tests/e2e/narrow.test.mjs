// Узкий экран (320 px): нет горизонтальной прокрутки, подписи кнопок не обрезаны.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addFromCamera, addFromGallery, addSigs, editorDone, isClickable, launch, menuAct, openApp, openEditor, startServer } from '../helpers.mjs';
import { fx, imagePdf, pdfInput } from '../pdfutil.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

const DEVICE = 'Galaxy S9+'; // ширина 320 px

/** Что не помещается: прокрутка страницы, обрезанные подписи, элементы за краем экрана. */
const overflow = (page, rootSelector) => page.evaluate(sel => {
  const root = document.querySelector(sel);
  const vw = document.documentElement.clientWidth;
  const out = { vw, pageScroll: document.documentElement.scrollWidth - vw, bodyScroll: document.body.scrollWidth - vw, clipped: [], outside: [] };
  const label = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} «${(el.textContent || '').trim().slice(0, 30)}»`;
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  for (const el of root.querySelectorAll('button, label, span, small, h1, h2, p, select, input, .num')) {
    if (!visible(el)) continue;
    if (el.scrollWidth > el.clientWidth + 0.5 && el.clientWidth > 0 && getComputedStyle(el).display !== 'inline') out.clipped.push(`${label(el)} ${el.scrollWidth}>${el.clientWidth}`);
    const r = el.getBoundingClientRect();
    // горизонтальная лента фильтров прокручивается по замыслу — её внутренности не считаем
    if (el.closest('#ed-filters')) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) out.outside.push(`${label(el)} ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return out;
}, rootSelector);

const assertFits = (o, where) => {
  assert.equal(o.vw, 320, 'устройство должно быть шириной 320 px');
  assert.ok(o.pageScroll <= 0, `${where}: горизонтальная прокрутка страницы ${o.pageScroll} px`);
  assert.ok(o.bodyScroll <= 0, `${where}: горизонтальная прокрутка body ${o.bodyScroll} px`);
  assert.deepEqual(o.clipped, [], `${where}: обрезанные подписи`);
  assert.deepEqual(o.outside, [], `${where}: элементы за краем экрана`);
};

describe('экран 320 px', () => {
  test('главный экран без страниц и со страницами', async () => {
    const { page } = await openApp(browser, server, { device: DEVICE });
    assertFits(await overflow(page, 'body'), 'пустой список');
    await addSigs(page, [0, 1, 2, 3, 4, 5]);
    assertFits(await overflow(page, 'body'), 'список из 6 страниц');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  });

  test('редактор: подписи кнопок не обрезаны, ничего не выходит за экран', async () => {
    const { page } = await openApp(browser, server, { device: DEVICE });
    await addFromCamera(page, 'white.jpg');
    // новая страница: видна и кнопка «Готово и снять ещё страницу»
    assert.equal(await page.locator('#ed-more').isVisible(), true);
    assertFits(await overflow(page, '#editor'), 'редактор новой страницы');

    // кнопки редактора: надписи целиком внутри своих кнопок
    const labels = await page.evaluate(() => [...document.querySelectorAll('#editor .tool, #editor .more-btn, #editor .editor-top button')].map(b => {
      const r = b.getBoundingClientRect();
      const inner = [...b.querySelectorAll('small')].map(s => { const sr = s.getBoundingClientRect(); return { text: s.textContent, ok: s.scrollWidth <= s.clientWidth && sr.left >= r.left - 0.5 && sr.right <= r.right + 0.5 }; });
      return { text: b.textContent.trim(), fits: b.scrollWidth <= b.clientWidth, inner, right: r.right, left: r.left };
    }));
    assert.ok(labels.length >= 9, `нашли ${labels.length} кнопок`);
    for (const l of labels) {
      assert.ok(l.fits, `кнопка «${l.text}» обрезана`);
      for (const s of l.inner) assert.ok(s.ok, `подпись «${s.text}» обрезана`);
      assert.ok(l.left >= -0.5 && l.right <= 320.5, `кнопка «${l.text}» за краем экрана`);
    }
    await editorDone(page);
  });

  test('редактор существующей страницы (без «снять ещё»)', async () => {
    const { page } = await openApp(browser, server, { device: DEVICE });
    await addFromGallery(page, ['white.jpg']);
    await openEditor(page, 1);
    assertFits(await overflow(page, '#editor'), 'редактор страницы');
  });

  test('кнопки «Отмена» и «Готово» доступны для нажатия', async () => {
    const { page } = await openApp(browser, server, { device: DEVICE });
    await addFromCamera(page, 'white.jpg');
    for (const id of ['#ed-cancel', '#ed-done', '#ed-retake', '#ed-delete']) {
      assert.ok(await isClickable(page, id), `${id} перекрыта другим элементом`);
    }
  });

  test('окно PDF помещается по ширине', async () => {
    const { page } = await openApp(browser, server, { device: DEVICE });
    await addFromGallery(page, ['white.jpg']);
    await page.click('#btn-pdf');
    assertFits(await overflow(page, '#sheet'), 'окно PDF');
    await page.click('#pdf-make');
    await page.waitForSelector('#pdf-download:not([hidden])');
    assertFits(await overflow(page, '#sheet'), 'окно PDF после создания');
  });

  test('окно «Объединить PDF»: пустое, со списком, с проектом и после объединения', async () => {
    const { page, errors } = await openApp(browser, server, { device: DEVICE });
    await addFromGallery(page, ['white.jpg']);
    await menuAct(page, 'merge');
    assertFits(await overflow(page, '#merge'), 'объединение: пусто');
    await page.setInputFiles('#in-merge', [pdfInput('a1', fx('text')), pdfInput('b2', fx('objstm')), pdfInput('c3', fx('hybrid'))]);
    await page.waitForSelector('#merge-list .merge-item:nth-child(3)');
    await page.waitForSelector('#busy[hidden]', { state: 'attached' });
    await page.selectOption('#merge-project', { index: 1 });
    assertFits(await overflow(page, '#merge'), 'объединение: список из 4 элементов');
    for (const sel of ['#merge-add-pdf', '#merge-make', '#merge-close', '#merge-project', '#merge-name', '.merge-up:not(:disabled)', '.merge-down:not(:disabled)', '.merge-del']) {
      await page.locator(sel).first().scrollIntoViewIfNeeded(); // окно прокручивается: кнопки внизу не видны сразу
      assert.ok(await isClickable(page, sel), `${sel} перекрыта`);
    }
    await page.click('#merge-make');
    await page.waitForSelector('#merge-download:not([hidden])');
    assertFits(await overflow(page, '#merge'), 'объединение: результат');
    for (const sel of ['#merge-download', '#merge-close']) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      assert.ok(await isClickable(page, sel), `${sel} перекрыта`);
    }
    assert.deepEqual(errors, []);
  });

  test('окно «Объединить PDF»: очень длинные имена обрезаются многоточием, кнопки ↑ ↓ ✕ остаются на экране', async () => {
    const { page, errors } = await openApp(browser, server, { device: DEVICE });
    await menuAct(page, 'merge');
    const long = 'Очень_длинное_название_файла_с_кириллицей_и_цифрами_1234567890_ещё_длиннее_чем_экран';
    await page.setInputFiles('#in-merge', [pdfInput(long, fx('text')), pdfInput(long + '2', fx('objstm'))]);
    await page.waitForSelector('#merge-list .merge-item:nth-child(2)');
    await page.waitForSelector('#busy[hidden]', { state: 'attached' });
    const r = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const out = { scroll: document.documentElement.scrollWidth - vw, outside: [] };
      for (const el of document.querySelectorAll('#merge .merge-item, #merge .merge-item button, #merge .merge-info')) {
        const b = el.getBoundingClientRect();
        if (b.left < -0.5 || b.right > vw + 0.5) out.outside.push(`${el.className} ${Math.round(b.left)}..${Math.round(b.right)}`);
      }
      const t = document.querySelector('.merge-title');
      out.ellipsis = t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow === 'ellipsis';
      return out;
    });
    assert.ok(r.scroll <= 0, `горизонтальная прокрутка ${r.scroll} px`);
    assert.deepEqual(r.outside, []);
    assert.ok(r.ellipsis, 'длинное имя должно обрезаться многоточием');
    assert.deepEqual(errors, []);
  });

  test('окно «Сжать PDF»: пустое, с выбранным файлом, со своим размером и с результатом', async () => {
    const { page, errors } = await openApp(browser, server, { device: DEVICE });
    await menuAct(page, 'compress');
    assertFits(await overflow(page, '#compress'), 'сжатие: пусто');
    const longName = 'Очень_длинное_название_сканированного_договора_с_приложениями_и_актами_2024.pdf';
    await page.setInputFiles('#in-compress', pdfInput(longName, fx('images')));
    await page.selectOption('#compress-target', 'custom');
    await page.fill('#compress-custom', '0.1');
    assertFits(await overflow(page, '#compress'), 'сжатие: файл и свой размер');
    for (const sel of ['#compress-pick', '#compress-target', '#compress-custom', '#compress-make', '#compress-close']) {
      await page.locator(sel).scrollIntoViewIfNeeded();
      assert.ok(await isClickable(page, sel), `${sel} перекрыта`);
    }
    await page.click('#compress-make');
    await page.waitForSelector('#compress-result:not([hidden])');
    await page.waitForSelector('#busy[hidden]', { state: 'attached', timeout: 30000 });
    await page.waitForSelector('#compress-download:not([hidden])');
    assertFits(await overflow(page, '#compress'), 'сжатие: результат');
    await page.locator('#compress-download').scrollIntoViewIfNeeded();
    assert.ok(await isClickable(page, '#compress-download'));
    assert.deepEqual(errors, []);
  });
});
