// Узкий экран (320 px): нет горизонтальной прокрутки, подписи кнопок не обрезаны.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { addFromCamera, addFromGallery, addSigs, editorDone, isClickable, launch, openApp, openEditor, startServer } from '../helpers.mjs';

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
});
