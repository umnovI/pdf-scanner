// Иконки — векторные SVG из набора в index.html, без эмодзи.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addFromCamera, addFromGallery, launch, phone, startServer } from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

// Эмодзи и символы-«иконки», которыми раньше были оформлены кнопки.
const EMOJI = /[←-⇿⌀-⏿①-➿⬀-⯿＋ℹ\u{1F300}-\u{1FAFF}]/u;

async function uiState(page) {
  return page.evaluate(() => {
    const ids = new Set([...document.querySelectorAll('symbol[id]')].map(x => x.id));
    const uses = [...document.querySelectorAll('use')];
    const broken = uses.map(u => u.getAttribute('href')).filter(h => !h?.startsWith('#') || !ids.has(h.slice(1)));
    // Иконки, которые сейчас действительно видны (не в скрытых окнах).
    const visible = uses.filter(u => { const r = u.closest('svg').getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
    // Весь текст интерфейса, включая скрытые окна, подсказки и списки выбора.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let text = '';
    for (let n; (n = walker.nextNode());) if (!n.parentElement.closest('script, style, svg')) text += n.textContent + ' ';
    text += [...document.querySelectorAll('option')].map(o => o.label).join(' ');
    const css = [...document.styleSheets].flatMap(x => [...x.cssRules]).map(r => r.cssText).join('\n');
    const contents = [...css.matchAll(/content:\s*"([^"]*)"/g)].map(m => m[1]).join(' ');
    return { visible, broken, text, contents };
  });
}

test('все иконки ссылаются на существующие символы, эмодзи в интерфейсе нет', async () => {
  const { page } = await phone(browser);
  await page.goto(server.url);
  await addFromGallery(page, ['white.jpg']);
  await page.click('#btn-menu');
  await page.click('#menu [data-act="projects"]');
  await page.waitForSelector('.project');
  await page.click('#projects-close');
  // Список страниц: иконки рисует JS (renderList).
  const listIcons = await page.locator('.page .row svg.icon').count();
  assert.equal(listIcons, 3, 'у страницы ◀ ✕ ▶ — SVG');
  await addFromCamera(page, 'yellow.jpg'); // редактор
  const s = await uiState(page);
  assert.ok(s.visible >= 12, `видимых иконок в редакторе и на экране: ${s.visible}`);
  assert.deepEqual(s.broken, [], 'ссылки на несуществующие иконки');
  assert.equal(EMOJI.exec(s.text)?.[0], undefined, 'эмодзи в тексте интерфейса');
  assert.equal(EMOJI.exec(s.contents)?.[0], undefined, 'эмодзи в CSS (content)');
});

test('иконки видимы и имеют размер (не нулевые, цвет от текста)', async () => {
  const { page } = await phone(browser);
  await page.goto(server.url);
  const sizes = await page.$$eval('.bottombar .icon, .topbar > button .icon', els => els.map(e => {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return { w: r.width, h: r.height, stroke: cs.stroke };
  }));
  assert.ok(sizes.length >= 5);
  for (const s of sizes) {
    assert.ok(s.w >= 14 && s.h >= 14, `иконка ${s.w}×${s.h}`);
    assert.notEqual(s.stroke, 'none');
  }
});
