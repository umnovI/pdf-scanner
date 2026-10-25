// Общие помощники для тестов: сервер приложения, браузер «телефона», фото, разбор PDF.
// Зависимости: Node.js 22+, playwright (devDependency), браузер Chromium.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';
import { afterEach } from 'node:test';
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
  return { dir: path.join(tmp, 'app'), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
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
  const old = !appDir && commit ? appFromCommit(commit) : null;
  fs.cpSync(appDir || old?.dir || path.join(ROOT, 'app'), dir, { recursive: true });
  // пустая страница для blankPage(): настоящий файл, а не page.route — иначе её запрос перехватит сервис-воркер приложения и получит 404
  fs.writeFileSync(path.join(dir, '__blank.html'), '<!doctype html><title>blank</title><link rel="icon" href="data:,">');
  old?.cleanup(); // копия уже лежит в папке сервера, распакованный коммит больше не нужен
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

// Контексты браузера, созданные в текущем тесте: после теста их закрывает afterEach ниже.
const live = [];

// Хук регистрируется при подключении помощников и действует на все тесты файла:
// 1) закрывает все контексты, созданные через phone()/openApp()/unitPage();
// 2) падает, если в консоли или на странице были ошибки, не разрешённые явно (опция allowErrors).
afterEach(async () => {
  const items = live.splice(0);
  const unexpected = [];
  for (const { errors, allowErrors } of items) {
    unexpected.push(...errors.filter(e => !allowErrors.some(re => re.test(e))));
  }
  await Promise.all(items.map(({ ctx }) => ctx.close().catch(() => {})));
  assert.deepEqual(unexpected, [], 'необработанные ошибки страницы или консоли');
});

/**
 * Новый «телефон» (Pixel 7) со сбором ошибок страницы и консоли (по всем вкладкам контекста).
 * После теста контекст закрывается сам, а непустой errors (кроме совпавших с allowErrors — список RegExp) роняет тест.
 */
export async function phone(browser, device = 'Pixel 7', { allowErrors = [] } = {}) {
  const ctx = await browser.newContext({ ...devices[device], acceptDownloads: true });
  const errors = [];
  const watch = pg => {
    pg.on('pageerror', e => errors.push(e.message));
    pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  };
  ctx.on('page', watch);
  live.push({ ctx, errors, allowErrors });
  const page = await ctx.newPage();
  return { ctx, page, errors };
}

/** Пустая страница того же происхождения: можно вызывать модули и работать с IndexedDB, не запуская приложение. */
export async function blankPage(page, server) {
  await page.addInitScript(rawIdbInit);
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
export async function openApp(browser, server, { device, url, init = [], allowErrors } = {}) {
  const p = await phone(browser, device, { allowErrors });
  await p.page.addInitScript(rawIdbInit);
  for (const fn of init) await p.page.addInitScript(fn);
  await p.page.goto(url || server.url);
  // Приложение готово, когда загрузило проект (название в шапке). Раньше фото добавлять нельзя:
  // у приложения ещё нет открытого проекта. В старых версиях (APP_COMMIT) этого элемента нет.
  await p.page.waitForFunction(() => {
    const el = document.getElementById('project-name');
    return !el || el.textContent !== 'Сканер PDF';
  }, null, { timeout: 15000 });
  return p;
}

/** Страницы открытого проекта так, как они записаны в IndexedDB, в порядке списка. */
export const dbRecords = page => page.evaluate(async () => {
  const pages = (await window.raw.all('pages')) || [];
  const meta = (await window.raw.all('meta')) || [];
  const projects = (await window.raw.all('projects')) || [];
  const cur = meta.find(m => m.key === 'current')?.id;
  const order = projects.find(p => p.id === cur)?.ids || [];
  return order.map(id => pages.find(p => p.id === id)).filter(Boolean)
    .map(({ id, rotation, corners, filter }) => ({ id, rotation, corners, filter }));
});

/** Все проекты и открытый (id) так, как они записаны в IndexedDB. */
export const dbProjects = page => page.evaluate(async () => ({
  projects: (await window.raw.all('projects')) || [],
  current: ((await window.raw.all('meta')) || []).find(m => m.key === 'current')?.id,
  pages: ((await window.raw.all('pages')) || []).map(p => p.id),
}));

/** Открывает меню «⋮» и нажимает пункт (data-act). */
export async function menuAct(page, act) {
  await page.click('#btn-menu');
  await page.click(`#menu [data-act="${act}"]`);
}

/** Открывает меню «⋮» и возвращает, доступна ли «Очистить проект» (меню остаётся открытым). */
export async function clearEnabled(page) {
  if (await page.locator('#menu').isHidden()) await page.click('#btn-menu');
  return !(await page.locator('#btn-clear').isDisabled());
}

/** Меню «⋮» → «Очистить проект» (подтверждение — отдельно, через page.once('dialog')). */
export async function clickClear(page) {
  await page.click('#btn-menu');
  await page.click('#btn-clear');
}

/** Открывает окно «Проекты». */
export async function openProjects(page) {
  await page.click('#btn-projects');
  await page.waitForSelector('#projects:not([hidden])');
}

/** Закрывает окно «Проекты». */
export async function closeProjects(page) {
  await page.click('#projects-close');
  await page.waitForSelector('#projects[hidden]', { state: 'attached' });
}

/** Создаёт новый проект через окно «Проекты»; ждёт, пока окно закроется и проект откроется. */
export async function newProject(page) {
  await openProjects(page);
  await page.click('#project-new');
  await page.waitForSelector('#projects[hidden]', { state: 'attached' });
}

/** Открывает проект по номеру в списке (с 1; новые сверху) и ждёт загрузки его страниц. */
export async function openProjectAt(page, n) {
  await openProjects(page);
  await page.locator('.project .project-open').nth(n - 1).click();
  await page.waitForSelector('#projects[hidden]', { state: 'attached' });
}

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

/** Элемент по центру получает нажатие: его не перекрывает другой элемент (плашка, окно и т. п.). */
export const isClickable = (page, selector) => page.evaluate(sel => {
  const b = document.querySelector(sel).getBoundingClientRect();
  return !!document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.closest(sel);
}, selector);

/** Даёт приложению обработать уже посланное событие: кадр отрисовки и короткая пауза (ждать условия здесь нечего). */
export const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50))));

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

// ---------- Проекты ----------

/** Ждёт, пока в шапке показано название открытого проекта (приложение запустилось и загрузило проект). */
export const waitName = (page, name) =>
  page.waitForFunction(n => document.getElementById('project-name').textContent === n, name, { timeout: 15000 });

/** Ждёт, пока в IndexedDB открытым записан проект с таким названием (запись «открытого» идёт в фоне). */
export const waitCurrentSaved = (page, name) => page.waitForFunction(async n => {
  const projects = (await window.raw.all('projects')) || [];
  const cur = ((await window.raw.all('meta')) || []).find(m => m.key === 'current')?.id;
  return projects.find(p => p.id === cur)?.name === n;
}, name, { timeout: 15000 });

/** Строки окна «Проекты»: название, строка со счётчиком, открыт ли, есть ли миниатюра. */
export const projectRows = page => page.evaluate(async () => {
  const rows = [...document.querySelectorAll('#project-list .project')];
  return Promise.all(rows.map(async li => {
    const im = li.querySelector('img');
    if (!im.hidden && im.src) await im.decode().catch(() => {});
    return {
      title: li.querySelector('.project-title').textContent,
      meta: li.querySelector('.project-meta').textContent,
      current: li.classList.contains('current'),
      thumb: im.hidden ? null : { w: im.naturalWidth, h: im.naturalHeight },
    };
  }));
});

/** Дата и время как в имени PDF (ГГГГ-ММ-ДД ЧЧ-ММ) по часам страницы. */
export const pageStamp = page => page.evaluate(() => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
});

/** Новый «телефон» с пустой страницей для вызова модулей (unit-тесты). */
export async function unitPage(browser, server, opts) {
  const p = await phone(browser, undefined, opts);
  await blankPage(p.page, server);
  return p;
}

/** Размеры (ширина, высота) JPEG для проверок PDF: вертикальные, горизонтальные, узкие, крошечные. */
export const PDF_SHAPES = {
  'вертикальное': [300, 400], 'горизонтальное': [400, 300], 'квадрат': [300, 300],
  'узкое вертикальное': [50, 600], 'узкое горизонтальное': [600, 50], 'крошечное': [1, 1],
};

/** Собирает PDF из JPEG заданных размеров [[w, h], …] модулем pdf.js и возвращает его байты. */
export async function buildPdfBytes(page, sizes, opts = {}) {
  const b64 = await inApp(page, async ({ pdf, util }, { sizes, opts }) => {
    const jpegs = [];
    for (const [w, h] of sizes) jpegs.push(await util.mkJpeg(w, h));
    return util.b64(await pdf.buildPdf(jpegs, opts));
  }, { sizes, opts });
  return Buffer.from(b64, 'base64');
}

/**
 * Средний цвет [r, g, b] центральной части листа фото после фильтра.
 * Прямоугольник выборки задан долями кадра (не пикселями): по центру, 30% ширины и 24% высоты.
 */
export function paperColor(page, name, filter, area = { x: 0.3, y: 0.32, w: 0.3, h: 0.24 }) {
  return inApp(page, async ({ img, util }, { b64, filter, area }) => {
    const base = await util.loadCanvas(b64);
    const c = img.makeCanvas(base.width, base.height);
    c.getContext('2d').drawImage(base, 0, 0);
    img.applyFilter(c, filter);
    const d = c.getContext('2d').getImageData(
      Math.round(area.x * c.width), Math.round(area.y * c.height),
      Math.round(area.w * c.width), Math.round(area.h * c.height)).data;
    let r = 0, g = 0, b = 0;
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return [r / n, g / n, b / n];
  }, { b64: fixtureB64(name), filter, area });
}
