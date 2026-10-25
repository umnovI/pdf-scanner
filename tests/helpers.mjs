// Общие помощники для тестов: сервер приложения, браузер «телефона», фото, разбор PDF.
// Зависимости: Node.js 20+, playwright (devDependency), браузер Chromium.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';
import { rawIdbInit } from './rawidb.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
export const truth = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'truth.json'), 'utf8'));
export const fixture = name => path.join(FIXTURES, name);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg',
};

/** Копия app/ из коммита (для проверки, что регрессионный тест падает на старом коде). */
export function appFromCommit(commit) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-scanner-old-'));
  execFileSync('sh', ['-c', 'git archive "$0" app | tar -x -C "$1"', commit, tmp], { cwd: ROOT });
  return path.join(tmp, 'app');
}

/**
 * Запускает сервер с копией app/ во временной папке — как GitHub Pages
 * (Cache-Control: max-age=600). build — номер версии, который подставляется
 * так же, как в workflow публикации. publish(v) «выкладывает» новую версию.
 * appDir — взять код приложения из другой папки; commit (или переменная окружения
 * APP_COMMIT) — из коммита: так тест запускают на старом коде.
 */
export async function startServer({ build, appDir, commit = process.env.APP_COMMIT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-scanner-'));
  fs.cpSync(appDir || (commit ? appFromCommit(commit) : path.join(ROOT, 'app')), dir, { recursive: true });
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

// UTF-8 — как на телефоне; иначе Chromium в контейнере без локали теряет
// кириллицу в именах скачиваемых файлов.
export const launch = () => chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });

/** Новый «телефон» (Pixel 7) со сбором ошибок страницы и консоли. */
export async function phone(browser, device = 'Pixel 7') {
  const ctx = await browser.newContext({ ...devices[device], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return { ctx, page, errors };
}

/** Пустая страница того же происхождения: можно вызывать модули и работать с IndexedDB, не запуская приложение. */
export async function blankPage(page, server) {
  await page.addInitScript(rawIdbInit);
  await page.route('**/__blank.html', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' }));
  await page.goto(server.url + '__blank.html');
  return page;
}

// ---------- Свои картинки: у каждой страницы своя пропорция, по ней её узнаём ----------

/** PNG однотонного цвета (без внешних библиотек). */
export function makePng(w, h, [r, g, b] = [200, 200, 200]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Файл для setInputFiles: картинка с пропорцией «высота/ширина = 1 + k/4». */
export const sigFile = (k, w = 200) => ({
  name: `sig${k}.png`, mimeType: 'image/png', buffer: makePng(w, Math.round(w * (1 + k / 4)), [(40 * k) % 256, 120, 200]),
});

/** Добавляет страницы-«метки» из галереи: k = 0, 1, 2… */
export async function addSigs(page, ks) {
  const before = await pageCount(page);
  await page.setInputFiles('#in-gallery', ks.map(k => sigFile(k)));
  await waitPages(page, before + ks.length);
}

/** Метки страниц (k из addSigs) в порядке на экране. */
export function pageSigs(page) {
  return page.evaluate(async () => {
    const imgs = [...document.querySelectorAll('.page img')];
    await Promise.all(imgs.map(i => i.decode().catch(() => {})));
    return imgs.map(i => Math.round((i.naturalHeight / i.naturalWidth - 1) * 4));
  });
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
    const b64 = blob => new Promise(res => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]);
      r.readAsDataURL(blob);
    });
    const fromB64 = (s, type = 'image/jpeg') => new Blob([Uint8Array.from(atob(s), c => c.charCodeAt(0))], { type });
    // JPEG заданного размера: фон и тёмная полоса, чтобы это не был пустой кадр.
    const mkJpeg = (w, h, color = '#c8c8c8', quality = 0.9) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = color; x.fillRect(0, 0, w, h);
      x.fillStyle = '#000'; x.fillRect(w / 4, h / 4, w / 2, h / 8);
      return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
    };
    // Холст из файла-фото (base64 JPEG), как его готовит приложение.
    const loadCanvas = async s => {
      const bmp = await img.decode(fromB64(s));
      const c = img.drawScaled(bmp, img.MAX_SRC);
      img.release(bmp);
      return c;
    };
    const util = { b64, fromB64, mkJpeg, loadCanvas };
    // eslint-disable-next-line no-new-func
    return (new Function('return ' + src))()({ img, pdf, db, util }, a);
  }, [fn.toString(), arg]);
}

/** Файл-фото в base64 — передать в inApp (util.loadCanvas). */
export const fixtureB64 = name => fs.readFileSync(fixture(name)).toString('base64');

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

export { rawIdbInit };

/** Открывает приложение на «телефоне»; window.raw — прямой доступ к IndexedDB. */
export async function openApp(browser, server, { device, url, init = [] } = {}) {
  const p = await phone(browser, device);
  await p.page.addInitScript(rawIdbInit);
  for (const fn of init) await p.page.addInitScript(fn);
  await p.page.goto(url || server.url);
  return p;
}

/** Страницы так, как они записаны в IndexedDB, в порядке списка. */
export const dbRecords = page => page.evaluate(async () => {
  const pages = (await window.raw.all('pages')) || [];
  const meta = (await window.raw.all('meta')) || [];
  const order = meta.find(m => m.key === 'order')?.ids || [];
  return order.map(id => pages.find(p => p.id === id)).filter(Boolean)
    .map(({ id, rotation, corners, filter }) => ({ id, rotation, corners, filter }));
});

/** Нажимает кнопку, открывающую выбор файла (камера), и выбирает файл: имя из fixtures или { name, mimeType, buffer }. */
export async function pick(page, clickSelector, file) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click(clickSelector)]);
  await chooser.setFiles(typeof file === 'string' ? fixture(file) : file);
}

/** Пропорции (высота/ширина) страниц на экране по порядку. */
export const pageRatios = page => page.evaluate(async () => {
  const imgs = [...document.querySelectorAll('.page img')];
  await Promise.all(imgs.map(i => i.decode().catch(() => {})));
  return imgs.map(i => Math.round(i.naturalHeight / i.naturalWidth * 100) / 100);
});

/** Выбранный сейчас фильтр в редакторе. */
export const activeFilter = page => page.evaluate(() => document.querySelector('#ed-filters .chip[aria-checked="true"]')?.dataset.f);

/** Открывает редактор страницы номер n (с 1) и ждёт его появления. */
export async function openEditor(page, n) {
  await page.locator('.page .thumb').nth(n - 1).click();
  await page.waitForSelector('#editor:not([hidden])');
}

// ---------- Сервис-воркер и обновления ----------

/** Ждёт, пока сервис-воркер установлен, активен и управляет страницей. */
export async function swReady(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}

/** Просит браузер проверить обновление sw.js (как при запуске или возврате в приложение). */
export const checkUpdate = page => page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));

/**
 * Барьер: спрашивает версию у воркера (протоколы старых и новых версий) и ждёт любого ответа.
 * К этому моменту страница обработала все сообщения воркера, пришедшие раньше.
 */
export const swBarrier = page => page.evaluate(() => new Promise(resolve => {
  const sw = navigator.serviceWorker;
  const on = e => {
    if (e.data && (e.data.type === 'version' || e.data.type === 'pdf-scanner-version')) {
      sw.removeEventListener('message', on);
      setTimeout(resolve, 0);
    }
  };
  sw.addEventListener('message', on);
  sw.controller.postMessage({ type: 'version' });
  sw.controller.postMessage({ type: 'pdf-scanner-version' });
}));

/** Плашка «Обновить» показана пользователю (не скрыта ни атрибутом, ни CSS). */
export const bannerVisible = page => page.locator('#update').isVisible();

/** Ждёт, пока приложение пометило, что есть обновление (атрибут hidden снят), даже если CSS прячет плашку. */
export const waitBannerFlag = page => page.waitForFunction(() => !document.getElementById('update').hidden);

/** Версия сборки, как её показывает окно «Сохранить PDF». */
export const versionText = page => page.evaluate(() => document.getElementById('version').textContent);

/** Подмена методов IndexedDB: window.__idbFail = { put: 'throw' | 'abort', delete: … } включает сбой. */
export function idbFailInit() {
  for (const method of ['put', 'delete']) {
    const orig = IDBObjectStore.prototype[method];
    IDBObjectStore.prototype[method] = function (...args) {
      const mode = window.__idbFail?.[method];
      if (mode === 'throw') throw new DOMException('тестовый сбой записи', 'QuotaExceededError');
      const res = orig.apply(this, args);
      if (mode === 'abort') this.transaction.abort();
      return res;
    };
  }
}

/** Новый «телефон» с пустой страницей для вызова модулей (unit-тесты). */
export async function unitPage(browser, server) {
  const p = await phone(browser);
  await blankPage(p.page, server);
  return p;
}
