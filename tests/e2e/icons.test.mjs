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
    const ids = new Set([...document.querySelectorAll('symbol[id]')].map(s => s.id));
    const uses = [...document.querySelectorAll('use')].map(u => u.getAttribute('href'));
    const broken = uses.filter(h => !h?.startsWith('#') || !ids.has(h.slice(1)));
    // Видимый текст всех элементов интерфейса (и скрытых окон), без текста тестовых страниц.
    const text = [...document.querySelectorAll('button, h1, h2, span, small, a, p, li, label')]
      .map(e => e.childNodes).flatMap(n => [...n]).filter(n => n.nodeType === 3).map(n => n.textContent).join(' ');
    const css = [...document.styleSheets].flatMap(s => [...s.cssRules]).map(r => r.cssText).join('\n');
    return { uses: uses.length, broken, text, css };
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
  await addFromCamera(page, 'yellow.jpg'); // редактор
  const s = await uiState(page);
  assert.ok(s.uses >= 20, `иконок на экране: ${s.uses}`);
  assert.deepEqual(s.broken, [], 'ссылки на несуществующие иконки');
  assert.equal(EMOJI.exec(s.text)?.[0], undefined, 'эмодзи в тексте интерфейса');
  assert.equal(/content:\s*"[^"]*[\u{1F300}-\u{1FAFF}]/u.test(s.css), false, 'эмодзи в CSS (content)');
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
