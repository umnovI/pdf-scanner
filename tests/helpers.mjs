// Общие помощники для тестов: сервер приложения, браузер «телефона», фото, разбор PDF.
// Зависимости: Node.js 20+, playwright (devDependency), браузер Chromium.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
export const truth = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'truth.json'), 'utf8'));
export const fixture = name => path.join(FIXTURES, name);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg',
};

/**
 * Запускает сервер с копией app/ во временной папке — как GitHub Pages
 * (Cache-Control: max-age=600). build — номер версии, который подставляется
 * так же, как в workflow публикации. publish(v) «выкладывает» новую версию.
 */
export async function startServer({ build } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-scanner-'));
  fs.cpSync(path.join(ROOT, 'app'), dir, { recursive: true });
  let current = '__BUILD__';
  const publish = v => {
    for (const f of ['sw.js', 'app.js']) {
      const p = path.join(dir, f);
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(`'${current}'`, `'${v}'`));
    }
    current = v;
  };
  if (build) publish(build);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let file = path.normalize(path.join(dir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' }).end(); return; }
      file = path.join(file, 'index.html');
    }
    if (!fs.existsSync(file)) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'max-age=600',
    });
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0, 'localhost', r));
  const url = `http://localhost:${server.address().port}/`;
  return {
    url, dir, publish,
    close: () => new Promise(r => { server.close(r); server.closeAllConnections?.(); fs.rmSync(dir, { recursive: true, force: true }); }),
  };
}

export const launch = () => chromium.launch();

/** Новый «телефон» (Pixel 7) со сбором ошибок страницы и консоли. */
export async function phone(browser, device = 'Pixel 7') {
  const ctx = await browser.newContext({ ...devices[device], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return { ctx, page, errors };
}

export const pageCount = page => page.locator('.page').count();

export async function waitPages(page, n, timeout = 30000) {
  await page.waitForFunction(k => document.querySelectorAll('.page').length === k, n, { timeout });
  await page.waitForSelector('#busy[hidden]', { state: 'attached', timeout });
}

/** Добавляет фото из галереи и ждёт обработки. */
export async function addFromGallery(page, names) {
  const before = await pageCount(page);
  await page.setInputFiles('#in-gallery', names.map(fixture));
  await waitPages(page, before + names.length);
}

/** Снимок камерой: ждёт открытия редактора. */
export async function addFromCamera(page, name) {
  await page.setInputFiles('#in-camera', fixture(name));
  await page.waitForSelector('#editor:not([hidden])', { timeout: 30000 });
}

export async function editorDone(page) {
  await page.click('#ed-done');
  await page.waitForSelector('#editor[hidden]', { state: 'attached' });
  await page.waitForSelector('#busy[hidden]', { state: 'attached', timeout: 30000 });
}

/** Создаёт PDF через интерфейс и возвращает его байты. */
export async function makePdf(page, { size, fit, margin, quality } = {}) {
  await page.click('#btn-pdf');
  if (size) await page.selectOption('#pdf-size', size);
  if (fit) await page.selectOption('#pdf-fit', fit);
  if (margin !== undefined) await page.selectOption('#pdf-margin', String(margin));
  if (quality) await page.selectOption('#pdf-quality', quality);
  await page.click('#pdf-make');
  await page.waitForSelector('#pdf-download:not([hidden])', { timeout: 60000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#pdf-download')]);
  const buf = fs.readFileSync(await dl.path());
  await page.click('#pdf-close');
  return { buf, filename: dl.suggestedFilename() };
}

/** Выполняет fn(модули) в браузере: { img, pdf, db } — модули приложения. */
export function inApp(page, fn, arg) {
  return page.evaluate(async ([src, a]) => {
    const [img, pdf, db] = await Promise.all(['./imgproc.js', './pdf.js', './db.js'].map(m => import(m)));
    // eslint-disable-next-line no-new-func
    return (new Function('return ' + src))()({ img, pdf, db }, a);
  }, [fn.toString(), arg]);
}

/** Минимальный разбор PDF: проверка таблицы xref, страницы, картинки, заголовок. */
export function parsePdf(buf) {
  const s = buf.toString('latin1');
  const errors = [];
  if (!s.startsWith('%PDF-')) errors.push('нет заголовка %PDF-');
  if (!s.trimEnd().endsWith('%%EOF')) errors.push('нет %%EOF');
  const sx = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s);
  const objects = {};
  if (!sx) errors.push('нет startxref');
  else {
    const xref = +sx[1];
    if (s.slice(xref, xref + 4) !== 'xref') errors.push('startxref указывает не на xref');
    const m = /^xref\n0 (\d+)\n/.exec(s.slice(xref));
    if (!m) errors.push('битая таблица xref');
    else {
      const n = +m[1];
      let p = xref + m[0].length;
      for (let i = 0; i < n; i++, p += 20) {
        const entry = s.slice(p, p + 20);
        if (!/^\d{10} \d{5} [nf] \n$/.test(entry)) { errors.push(`битая запись xref ${i}`); break; }
        if (entry[17] === 'n') {
          const off = +entry.slice(0, 10);
          if (!s.startsWith(`${i} 0 obj`, off)) errors.push(`объект ${i}: смещение ${off} неверно`);
          objects[i] = off;
        }
      }
    }
  }
  const pages = [...s.matchAll(/\/Type \/Page \/Parent[^>]*?\/MediaBox \[([^\]]+)\]/g)].map(m => m[1].trim().split(/\s+/).map(Number));
  const images = [...s.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+) \/ColorSpace \/(\w+)/g)].map(m => ({ w: +m[1], h: +m[2], cs: m[3] }));
  const count = +(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s) || [])[1];
  return { errors, pages, images, count, objects };
}

/** Максимальное расстояние между найденными и настоящими углами (в пикселях). */
export function cornerError(found, expected) {
  return Math.max(...found.map((p, i) => Math.hypot(p[0] - expected[i][0], p[1] - expected[i][1])));
}
