import * as img from './imgproc.js';
import { buildPdf } from './pdf.js';
import * as db from './db.js';

const $ = id => document.getElementById(id);
const BUILD = '__BUILD__'; // при публикации заменяется на номер коммита
const OUT_QUALITY = 0.9;
const QUALITY = {
  high: { maxSide: Infinity, q: 0.9 },
  medium: { maxSide: 1800, q: 0.8 },
  low: { maxSide: 1300, q: 0.65 },
};

const state = {
  pages: [],          // страницы открытого проекта по порядку:
                      // { id, src, rotation, corners, filter, out, thumb, thumbUrl }
  project: null,      // открытый проект { id, name, created, filter, ids }
  projects: [],       // все проекты (новые сверху); ids актуальны для закрытых
  memory: new Map(),  // страницы закрытых проектов, которые нельзя перечитать из базы
                      // (нет IndexedDB или есть несохранённые страницы)
  persist: true,
  writes: new Set(),   // незавершённые записи в IndexedDB
  unsaved: new Set(),  // id страниц, последнее сохранение которых не удалось
  dbFailed: new Set(), // id проектов, где не записались удаление/порядок/название
  newVersion: false,   // загружена новая версия приложения
  dbClosed: false,     // база закрыта другой вкладкой — сохранять больше нельзя
  pdf: null,          // готовый PDF { blob, name }
};

// ---------- Настройки ----------

const settings = {
  get(key, def) {
    try { return localStorage.getItem('ps.' + key) ?? def; } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem('ps.' + key, value); } catch { /* приватный режим */ }
  },
};

// ---------- Мелочи интерфейса ----------

let toastTimer = 0;
function toast(text, ms = 2600) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function busy(text) {
  $('busy-text').textContent = text || 'Обработка…';
  $('busy').hidden = !text;
}

// Даём браузеру отрисовать индикатор перед тяжёлой работой.
const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

const uid = db.newId;

function record(p) {
  const { id, src, rotation, corners, filter, out, thumb } = p;
  return { id, src, rotation, corners, filter, out, thumb };
}

// Отслеживает запись в IndexedDB: перезагрузка для обновления её дождётся.
// Возвращает true, если запись удалась.
function track(promise) {
  const done = promise.then(() => true, e => { console.warn(e); return false; });
  state.writes.add(done);
  done.finally(() => state.writes.delete(done));
  return done;
}

// Номер последней записи каждой страницы: результат учитывается только у
// последней, иначе запоздавшая старая запись перебьёт итог новой.
const writeSeq = new Map();

const pageIds = () => state.pages.map(p => p.id);

// Актуальные ссылки проекта на фото: у открытого — по текущему списку страниц.
const idsOf = p => (p === state.project ? pageIds() : p.ids);

// Копия проекта для записи в базу (с актуальным списком страниц).
function snapshot(p) {
  if (p === state.project) p.ids = pageIds();
  return { ...p, ids: [...p.ids] };
}
const projectRecord = () => snapshot(state.project);
const otherProjects = () => state.projects.filter(p => p !== state.project).map(snapshot);

// Сохраняет страницу (вместе с проектом и текущим порядком страниц).
async function persist(p) {
  if (!state.persist) return;
  const seq = (writeSeq.get(p.id) || 0) + 1;
  writeSeq.set(p.id, seq);
  const projectId = state.project.id;
  const ok = await track(db.savePage(record(p), projectRecord()));
  if (writeSeq.get(p.id) !== seq) return;
  if (ok) {
    state.unsaved.delete(p.id);
    state.dbFailed.delete(projectId); // вместе со страницей записан весь проект
  } else {
    state.unsaved.add(p.id);
  }
}

// Запись проекта (порядок, удаление страниц, название). Удачная запись заменяет
// весь проект, поэтому исправляет и последствия прошлых сбоев в нём.
async function persistOrder(promise, projectId = state.project.id) {
  if (await track(promise)) state.dbFailed.delete(projectId);
  else state.dbFailed.add(projectId);
}

function setThumb(p) {
  if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
  p.thumbUrl = URL.createObjectURL(p.thumb);
}

// ---------- Список страниц ----------

function renderList() {
  const list = $('pages');
  list.textContent = '';
  const n = state.pages.length;
  state.pages.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'page';
    li.innerHTML = `
      <button class="thumb" aria-label="Изменить страницу ${i + 1}"><img alt=""></button>
      <span class="num">${i + 1}</span>
      <div class="row">
        <button class="left" aria-label="Переместить влево" ${i === 0 ? 'disabled' : ''}>◀</button>
        <button class="del" aria-label="Удалить">✕</button>
        <button class="right" aria-label="Переместить вправо" ${i === n - 1 ? 'disabled' : ''}>▶</button>
      </div>`;
    li.querySelector('img').src = p.thumbUrl;
    li.querySelector('.thumb').onclick = () => openEditor(p);
    li.querySelector('.left').onclick = () => move(i, -1);
    li.querySelector('.right').onclick = () => move(i, 1);
    li.querySelector('.del').onclick = () => removePage(p);
    list.appendChild(li);
  });
  $('empty').hidden = n > 0;
  $('btn-clear').disabled = n === 0;
  $('btn-pdf').disabled = n === 0;
  $('btn-pdf').innerHTML = `<span aria-hidden="true">📄</span> PDF${n ? ` (${n})` : ''}`;
}

async function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.pages.length) return;
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  renderList();
  if (state.persist) persistOrder(db.saveProject(projectRecord()));
}

async function removePage(p) {
  if (!confirm('Удалить эту страницу?')) return false;
  state.pages = state.pages.filter(x => x !== p);
  if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl);
  renderList();
  writeSeq.delete(p.id);
  state.unsaved.delete(p.id);
  if (state.persist) persistOrder(db.removePages(projectRecord(), [p.id], otherProjects()));
  return true;
}

// ---------- Добавление фото ----------

async function processPage(p) {
  const c = await img.renderPage(p);
  p.out = await img.toBlob(c, OUT_QUALITY);
  p.thumb = await img.toBlob(img.drawScaled(c, 420), 0.8);
  setThumb(p);
}

async function addFiles(files, { fromCamera = false, replace = null } = {}) {
  // Сначала копия списка: поле выбора файла очищается сразу после вызова.
  files = [...files].filter(f => f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
  if (!files.length) return;
  await ready; // фото, выбранное сразу после запуска, ждёт загрузки проекта
  if (!state.project) { toast('Не удалось открыть проект — перезапустите приложение'); return; }
  if (replace && state.pages.includes(replace)) return retake(replace, files[0]);
  const added = [];
  const filter = state.project.filter; // последний выбранный в проекте фильтр
  for (let i = 0; i < files.length; i++) {
    busy(files.length > 1 ? `Обработка ${i + 1} из ${files.length}…` : 'Обработка…');
    await frame();
    try {
      const bitmap = await img.decode(files[i]);
      const c = img.drawScaled(bitmap, img.MAX_SRC);
      img.release(bitmap);
      const p = {
        id: uid(),
        src: await img.toBlob(c, 0.92),
        rotation: 0,
        corners: img.FULL_FRAME.map(pt => [...pt]),
        filter,
      };
      if (fromCamera) {
        const found = img.detectDocument(c);
        if (found) p.corners = found;
      }
      await processPage(p);
      state.pages.push(p);
      added.push(p);
      await persist(p);
    } catch (e) {
      console.error(e);
      toast(`Не удалось открыть «${files[i].name}»`);
    }
  }
  busy(null);
  renderList();
  if (fromCamera && added.length === 1) openEditor(added[0], { isNew: true });
  else if (added.length > 1) toast(`Добавлено страниц: ${added.length}`);
}

// Заменяет фото страницы новым снимком; номер страницы и фильтр сохраняются.
async function retake(p, file) {
  busy('Обработка…');
  await frame();
  const old = { src: p.src, rotation: p.rotation, corners: p.corners };
  try {
    const bitmap = await img.decode(file);
    const c = img.drawScaled(bitmap, img.MAX_SRC);
    img.release(bitmap);
    p.src = await img.toBlob(c, 0.92);
    p.rotation = 0;
    p.corners = img.detectDocument(c) || img.FULL_FRAME.map(pt => [...pt]);
    await processPage(p);
    await persist(p);
  } catch (e) {
    console.error(e);
    Object.assign(p, old);
    busy(null);
    toast('Не удалось открыть новое фото');
    return;
  }
  busy(null);
  renderList();
  openEditor(p, { isNew: true });
}

// Какую страницу переснимаем (null — обычная съёмка новой страницы).
let retakeTarget = null;

function openCamera(target = null) {
  retakeTarget = target;
  $('in-camera').click();
}

// ---------- Редактор ----------

const ed = {
  page: null,
  isNew: false,
  base: null,       // уменьшенный оригинал с учётом поворота
  preview: null,    // base с применённым фильтром
  rotation: 0,
  corners: null,
  filter: 'original',
  rect: null,       // где картинка лежит на холсте (в CSS-пикселях)
  drag: -1,
};

async function openEditor(p, { isNew = false } = {}) {
  busy('Открываю…');
  await frame();
  try {
    const bitmap = await img.decode(p.src);
    ed.source = img.drawScaled(bitmap, 1400);
    img.release(bitmap);
  } catch (e) {
    busy(null);
    toast('Не удалось открыть страницу');
    return;
  }
  ed.page = p;
  ed.isNew = isNew;
  ed.rotation = p.rotation;
  ed.corners = p.corners.map(pt => [...pt]);
  ed.filter = p.filter;
  $('ed-title').textContent = `Страница ${state.pages.indexOf(p) + 1}`;
  $('ed-more').hidden = !isNew;
  $('editor').hidden = false;
  busy(null);
  rebuildBase();
  syncChips();
}

function closeEditor() {
  $('editor').hidden = true;
  ed.page = ed.source = ed.base = ed.preview = null;
}

function rebuildBase() {
  ed.base = img.rotateCanvas(ed.source, ed.rotation);
  rebuildPreview();
}

function rebuildPreview() {
  const c = img.makeCanvas(ed.base.width, ed.base.height);
  c.getContext('2d').drawImage(ed.base, 0, 0);
  ed.preview = img.applyFilter(c, ed.filter);
  layoutEditor();
}

function layoutEditor() {
  const stage = $('ed-stage');
  const canvas = $('ed-canvas');
  const pad = 22;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const k = Math.min((sw - 2 * pad) / ed.base.width, (sh - 2 * pad) / ed.base.height);
  const w = ed.base.width * k, h = ed.base.height * k;
  const x = (sw - w) / 2, y = (sh - h) / 2;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.left = '0px';
  canvas.style.top = '0px';
  canvas.style.width = sw + 'px';
  canvas.style.height = sh + 'px';
  canvas.width = Math.round(sw * dpr);
  canvas.height = Math.round(sh * dpr);
  ed.rect = { x, y, w, h, dpr };
  drawEditor();
}

function drawEditor() {
  if (!ed.preview) return;
  const canvas = $('ed-canvas');
  const ctx = canvas.getContext('2d');
  const { x, y, w, h, dpr } = ed.rect;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(ed.preview, x, y, w, h);

  const pts = ed.corners.map(([u, v]) => [x + u * w, y + v * h]);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.moveTo(...pts[0]);
  for (let i = 1; i < 4; i++) ctx.lineTo(...pts[i]);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill('evenodd');

  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (let i = 1; i < 4; i++) ctx.lineTo(...pts[i]);
  ctx.closePath();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#4c8dff';
  ctx.stroke();

  document.querySelectorAll('.handle').forEach(hd => {
    const [px, py] = pts[+hd.dataset.i];
    hd.style.left = px + 'px';
    hd.style.top = py + 'px';
  });
}

function drawLoupe(i) {
  const loupe = $('ed-loupe');
  const { x, y, w, h } = ed.rect;
  const [u, v] = ed.corners[i];
  const lctx = loupe.getContext('2d');
  const zoom = 3;
  const srcSize = (loupe.clientWidth || 120) / zoom * (ed.preview.width / w);
  const cx = u * ed.preview.width, cy = v * ed.preview.height;
  lctx.fillStyle = '#000';
  lctx.fillRect(0, 0, loupe.width, loupe.height);
  lctx.imageSmoothingEnabled = true;
  lctx.drawImage(ed.preview, cx - srcSize / 2, cy - srcSize / 2, srcSize, srcSize, 0, 0, loupe.width, loupe.height);
  const m = loupe.width / 2;
  lctx.strokeStyle = '#4c8dff';
  lctx.lineWidth = 3;
  lctx.beginPath();
  lctx.moveTo(m - 18, m); lctx.lineTo(m + 18, m);
  lctx.moveTo(m, m - 18); lctx.lineTo(m, m + 18);
  lctx.stroke();
  // Лупа уходит в противоположный от пальца угол.
  const stage = $('ed-stage');
  const left = x + u * w < stage.clientWidth / 2;
  loupe.style.left = left ? '' : '10px';
  loupe.style.right = left ? '10px' : '';
  loupe.style.top = (y + v * h < 150) ? '' : '10px';
  loupe.style.bottom = (y + v * h < 150) ? '10px' : '';
}

function setupHandles() {
  document.querySelectorAll('.handle').forEach(hd => {
    const i = +hd.dataset.i;
    hd.addEventListener('pointerdown', e => {
      e.preventDefault();
      hd.setPointerCapture(e.pointerId);
      ed.drag = i;
      hd.classList.add('active');
      $('ed-loupe').hidden = false;
      drawLoupe(i);
    });
    hd.addEventListener('pointermove', e => {
      if (ed.drag !== i) return;
      const stage = $('ed-stage').getBoundingClientRect();
      const { x, y, w, h } = ed.rect;
      const u = Math.min(1, Math.max(0, (e.clientX - stage.left - x) / w));
      const v = Math.min(1, Math.max(0, (e.clientY - stage.top - y) / h));
      ed.corners[i] = [u, v];
      drawEditor();
      drawLoupe(i);
    });
    const end = () => {
      if (ed.drag !== i) return;
      ed.drag = -1;
      hd.classList.remove('active');
      $('ed-loupe').hidden = true;
    };
    hd.addEventListener('pointerup', end);
    hd.addEventListener('pointercancel', end);
  });
}

function syncChips() {
  document.querySelectorAll('#ed-filters .chip').forEach(ch => {
    ch.setAttribute('role', 'radio');
    ch.setAttribute('aria-checked', String(ch.dataset.f === ed.filter));
  });
}

// Проверка, что рамка — выпуклый четырёхугольник (иначе выравнивание даст мусор).
function isConvex(c) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = c[i], [bx, by] = c[(i + 1) % 4], [cx, cy] = c[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-6) return false;
    const s = Math.sign(cross);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

async function editorDone({ another = false } = {}) {
  const p = ed.page;
  if (!isConvex(ed.corners)) {
    toast('Рамка перекручена — поправьте углы');
    return;
  }
  // Камеру нужно открыть сразу по нажатию, иначе браузер её заблокирует.
  if (another) openCamera();
  const changed = p.rotation !== ed.rotation || p.filter !== ed.filter ||
    JSON.stringify(p.corners) !== JSON.stringify(ed.corners);
  closeEditor();
  if (!changed) return;
  p.rotation = ed.rotation;
  p.corners = ed.corners;
  // Выбранный фильтр становится фильтром проекта — для всех следующих фото.
  // (Запишется вместе со страницей.)
  if (p.filter !== ed.filter) state.project.filter = ed.filter;
  p.filter = ed.filter;
  settings.set('filter', p.filter); // для новых проектов
  busy('Обработка…');
  await frame();
  try {
    await processPage(p);
    await persist(p);
  } catch (e) {
    console.error(e);
    toast('Ошибка обработки');
  }
  busy(null);
  renderList();
}

function setupEditor() {
  setupHandles();
  $('ed-cancel').onclick = closeEditor;
  $('ed-done').onclick = () => editorDone();
  $('ed-retake').onclick = () => {
    const p = ed.page;
    openCamera(p); // открываем камеру сразу по нажатию, иначе браузер заблокирует
    closeEditor();
  };
  $('ed-more').onclick = () => editorDone({ another: true });
  $('ed-rotl').onclick = () => {
    ed.rotation = (ed.rotation + 270) % 360;
    ed.corners = img.rotateCorners(ed.corners, -1);
    rebuildBase();
  };
  $('ed-rotr').onclick = () => {
    ed.rotation = (ed.rotation + 90) % 360;
    ed.corners = img.rotateCorners(ed.corners, 1);
    rebuildBase();
  };
  $('ed-full').onclick = () => {
    ed.corners = img.FULL_FRAME.map(pt => [...pt]);
    drawEditor();
  };
  $('ed-auto').onclick = () => {
    const found = img.detectDocument(ed.base);
    if (found) { ed.corners = found; drawEditor(); } else toast('Края не найдены — выставьте углы вручную');
  };
  $('ed-delete').onclick = async () => {
    const p = ed.page;
    if (await removePage(p)) closeEditor();
  };
  document.querySelectorAll('#ed-filters .chip').forEach(ch => {
    ch.onclick = () => {
      if (ed.filter === ch.dataset.f) return;
      ed.filter = ch.dataset.f;
      syncChips();
      rebuildPreview();
    };
  });
  window.addEventListener('resize', () => { if (ed.page) layoutEditor(); });
}

// ---------- PDF ----------

function defaultName() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}`;
  return `${state.project?.name || 'Скан'} ${stamp}`;
}

function safeName(s) {
  return (s.trim() || defaultName()).replace(/[\\/:*?"<>|]+/g, '_').replace(/\.pdf$/i, '');
}

function formatSize(bytes) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function openSheet() {
  state.pdf = null;
  $('pdf-name').value = defaultName();
  const size = settings.get('size', 'a4');
  $('pdf-size').value = size === 'letter' ? 'letter' : 'a4';
  $('pdf-fit').value = settings.get('fit', 'fill') === 'fit' ? 'fit' : 'fill';
  $('pdf-margin').value = settings.get('margin', '0');
  $('pdf-quality').value = settings.get('quality', 'high');
  resetSheetResult();
  $('sheet').hidden = false;
}

function resetSheetResult() {
  state.pdf = null;
  $('pdf-result').hidden = true;
  $('pdf-share').hidden = true;
  $('pdf-download').hidden = true;
  $('pdf-make').hidden = false;
}

async function recompress(blob, { maxSide, q }) {
  if (!isFinite(maxSide)) return blob;
  const bitmap = await img.decode(blob);
  const c = img.drawScaled(bitmap, maxSide);
  img.release(bitmap);
  return img.toBlob(c, q);
}

async function makePdf() {
  const size = $('pdf-size').value;
  const margin = $('pdf-margin').value;
  const fit = $('pdf-fit').value;
  settings.set('fit', fit);
  const quality = $('pdf-quality').value;
  settings.set('size', size);
  settings.set('margin', margin);
  settings.set('quality', quality);
  const name = safeName($('pdf-name').value);
  try {
    const jpegs = [];
    for (let i = 0; i < state.pages.length; i++) {
      busy(`Готовлю страницу ${i + 1} из ${state.pages.length}…`);
      await frame();
      jpegs.push(await recompress(state.pages[i].out, QUALITY[quality] || QUALITY.high));
    }
    busy('Собираю PDF…');
    await frame();
    const blob = await buildPdf(jpegs, { size, margin, fit, title: name });
    state.pdf = { blob, name };
    $('pdf-result').textContent = `Готово: ${state.pages.length} стр., ${formatSize(blob.size)}`;
    $('pdf-result').hidden = false;
    $('pdf-make').hidden = true;
    $('pdf-download').hidden = false;
    $('pdf-share').hidden = !canShareFiles();
  } catch (e) {
    console.error(e);
    toast('Не удалось создать PDF');
  }
  busy(null);
}

function pdfFile() {
  return new File([state.pdf.blob], state.pdf.name + '.pdf', { type: 'application/pdf' });
}

function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({
      files: [new File([new Uint8Array(1)], 'x.pdf', { type: 'application/pdf' })],
    }));
  } catch { return false; }
}

async function sharePdf() {
  if (!state.pdf) return;
  try {
    await navigator.share({ files: [pdfFile()], title: state.pdf.name });
  } catch (e) {
    if (e.name !== 'AbortError') toast('Не получилось поделиться — используйте «Скачать»');
  }
}

function downloadPdf() {
  if (!state.pdf) return;
  const url = URL.createObjectURL(state.pdf.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.pdf.name + '.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- Проекты ----------
// Проект — отдельная «папка» со своими страницами. Новый проект не трогает
// старые: они остаются в списке, их можно открыть и продолжить.

// Открывает проект: загружает его страницы. remember — запомнить как открытый.
// Если страницы не загрузились, проект открывается пустым с предупреждением.
async function openProject(id, { remember = true } = {}) {
  const project = state.projects.find(p => p.id === id) || state.projects[0];
  if (state.project) {
    state.project.ids = pageIds();
    // Страницы, которых нет в базе (без IndexedDB или не сохранились), держим
    // в памяти — иначе при возврате в проект они пропадут.
    if (!state.persist || state.pages.some(p => state.unsaved.has(p.id))) {
      state.memory.set(state.project.id, state.pages);
    } else {
      state.memory.delete(state.project.id);
      state.pages.forEach(p => p.thumbUrl && URL.revokeObjectURL(p.thumbUrl));
    }
  }
  let pages = state.memory.get(project.id);
  // Открытый проект живёт в state.pages; в памяти закрытых его больше нет —
  // иначе его страницы считались бы дважды.
  state.memory.delete(project.id);
  if (!pages && state.persist) {
    try {
      pages = await db.loadPages(project.ids);
    } catch (e) {
      console.warn(e);
      toast('Не удалось загрузить страницы проекта');
    }
  }
  state.project = project;
  state.pages = (pages || []).filter(p => p.src && p.out && p.thumb);
  state.pages.forEach(p => { if (!p.thumbUrl) setThumb(p); });
  if (remember && state.persist) track(db.setCurrent(project.id));
  renderProjectTitle();
  renderList();
}

function renderProjectTitle() {
  $('project-name').textContent = state.project.name;
}

function nextProjectName() {
  const names = new Set(state.projects.map(p => p.name));
  let n = state.projects.length + 1;
  while (names.has(`Проект ${n}`)) n++;
  return `Проект ${n}`;
}

async function newProject() {
  const filter = state.project?.filter || settings.get('filter', 'enhance');
  const project = db.makeProject(nextProjectName(), filter);
  if (state.persist && !(await track(db.createProject(project)))) {
    toast('Не удалось создать проект');
    return;
  }
  state.projects.unshift(project);
  await openProject(project.id, { remember: false });
  closeProjects();
  toast(`Создан «${project.name}». Прошлые проекты — в списке «Проекты».`);
}

async function renameProject(project) {
  const name = prompt('Название проекта', project.name)?.trim();
  if (!name || name === project.name) return;
  project.name = name;
  if (project === state.project) renderProjectTitle();
  if (state.persist) persistOrder(db.saveProject(snapshot(project)), project.id);
  renderProjects();
}

async function deleteProject(project) {
  const ids = idsOf(project);
  if (!confirm(`Удалить проект «${project.name}»${ids.length ? ` и его страницы (${ids.length})` : ''}?`)) return;
  const others = state.projects.filter(p => p !== project);
  let next = null;
  if (project === state.project) {
    next = others[0] || db.makeProject(nextProjectName(), project.filter);
    if (!others.length) others.push(next);
  }
  if (state.persist) {
    const ok = await track(db.deleteProject(snapshot(project), others.map(snapshot), next && snapshot(next)));
    if (!ok) { toast('Не удалось удалить проект'); return; }
  }
  ids.forEach(id => { writeSeq.delete(id); state.unsaved.delete(id); });
  (state.memory.get(project.id) || []).forEach(p => p.thumbUrl && URL.revokeObjectURL(p.thumbUrl));
  state.memory.delete(project.id);
  state.dbFailed.delete(project.id);
  state.projects = others;
  if (next) {
    // Открытый проект удалён — его страницы не сохраняем при переключении.
    state.pages.forEach(p => p.thumbUrl && URL.revokeObjectURL(p.thumbUrl));
    state.pages = [];
    state.project = null;
    await openProject(next.id, { remember: false });
  }
  renderProjects();
}

// --- Окно «Проекты» ---

let projectThumbs = [];
let renderToken = 0; // миниатюры, догрузившиеся после перерисовки, не используются

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}

function releaseProjectThumbs() {
  projectThumbs.forEach(u => URL.revokeObjectURL(u));
  projectThumbs = [];
}

async function renderProjects() {
  if ($('projects').hidden) return;
  const token = ++renderToken;
  releaseProjectThumbs();
  const list = $('project-list');
  list.textContent = '';
  const images = new Map(); // id первой страницы → <img>
  const pending = [];
  for (const p of state.projects) {
    const ids = idsOf(p);
    const li = document.createElement('li');
    li.className = 'project' + (p === state.project ? ' current' : '');
    li.innerHTML = `
      <button class="project-open">
        <span class="project-thumb"><img alt="" hidden></span>
        <span class="project-info">
          <span class="project-title"></span>
          <span class="project-meta"></span>
        </span>
      </button>
      <button class="project-rename" aria-label="Переименовать">✎</button>
      <button class="project-delete" aria-label="Удалить проект">🗑</button>`;
    li.querySelector('.project-title').textContent = p.name;
    li.querySelector('.project-meta').textContent =
      `${ids.length} стр. · ${formatDate(p.created)}${p === state.project ? ' · открыт' : ''}`;
    li.querySelector('.project-open').onclick = async () => {
      if (p !== state.project) await openProject(p.id);
      closeProjects();
    };
    li.querySelector('.project-rename').onclick = () => renameProject(p);
    li.querySelector('.project-delete').onclick = () => deleteProject(p);
    list.appendChild(li);
    // Миниатюра первой страницы: из памяти, иначе — из базы (одним запросом ниже).
    const im = li.querySelector('img');
    const inMemory = (p === state.project ? state.pages : state.memory.get(p.id))?.[0]?.thumb;
    if (inMemory) showThumb(im, inMemory);
    else if (ids.length && state.persist) { images.set(ids[0], im); pending.push(ids[0]); }
  }
  if (!pending.length) return;
  try {
    const thumbs = await db.loadThumbs(pending);
    if (token !== renderToken || $('projects').hidden) return;
    thumbs.forEach((blob, i) => showThumb(images.get(pending[i]), blob));
  } catch (e) {
    console.warn(e);
  }
}

function showThumb(im, blob) {
  if (!blob || !im) return;
  const url = URL.createObjectURL(blob);
  projectThumbs.push(url);
  im.src = url;
  im.hidden = false;
}

function openProjects() {
  $('projects').hidden = false;
  renderProjects();
}

function closeProjects() {
  $('projects').hidden = true;
  renderToken++;
  releaseProjectThumbs();
}

function setupProjects() {
  $('btn-projects').onclick = async () => { await ready; openProjects(); };
  $('projects-close').onclick = closeProjects;
  $('project-new').onclick = newProject;
  $('projects').addEventListener('click', e => { if (e.target === $('projects')) closeProjects(); });
}

// ---------- Обновления ----------

// Установленное приложение почти не перезагружается, поэтому новую версию
// проверяем при запуске, при возврате из фона и раз в час (пока приложение на
// экране, не чаще раза в 5 минут). Новый воркер, став активным, рассылает свою
// версию; если она отличается от версии страницы — показываем плашку «Обновить».
// Поверх редактора, окна PDF и обработки плашка не видна (см. style.css).
// Вызывается синхронно при запуске: до этого браузер придерживает сообщения
// воркера, и рассылка, пришедшая раньше, не потеряется.
function setupUpdates() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  const sw = navigator.serviceWorker;
  sw.addEventListener('message', e => {
    if (e.data?.type === 'pdf-scanner-version') {
      state.newVersion = e.data.version !== BUILD;
      showUpdateBanner();
      if (state.newVersion) setAboutUpdate(`Есть версия ${e.data.version}`);
    }
  });
  sw.startMessages(); // включаем доставку явно: addEventListener сам её не включает

  // Вкладка вернулась из кэша браузера и могла пропустить рассылку — спрашиваем сами.
  window.addEventListener('pageshow', e => {
    if (e.persisted) sw.controller?.postMessage({ type: 'pdf-scanner-version' });
  });

  let lastCheck = Date.now();
  sw.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    state.reg = reg;
    const check = () => {
      if (document.hidden || Date.now() - lastCheck < 5 * 60 * 1000) return;
      lastCheck = Date.now();
      reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', check);
    setInterval(check, 60 * 60 * 1000);
  }).catch(console.warn);
}

// ---------- Меню и «О приложении» ----------

function setAboutUpdate(text) {
  $('about-update').textContent = text;
  // Плашка «Обновить» под окном не видна — кнопка прямо в окне.
  $('about-reload').hidden = !state.newVersion;
}

// Проверка обновления вручную. Если есть новая версия, она загрузится,
// и новый воркер сам сообщит о себе (плашка «Обновить»).
async function checkForUpdate() {
  if (state.newVersion) { setAboutUpdate('Есть новая версия'); return; }
  if (!state.reg) {
    setAboutUpdate(BUILD.startsWith('__') ? 'Не проверяется (версия для разработки)' : 'Недоступно в этом браузере');
    return;
  }
  setAboutUpdate('Проверяю…');
  try {
    await state.reg.update();
    const incoming = state.reg.installing || state.reg.waiting;
    if (incoming) {
      setAboutUpdate('Загружается новая версия…');
      // Если версия та же (изменился только файл воркера) или сообщение не пришло —
      // не оставляем «Загружается…» навсегда.
      incoming.addEventListener('statechange', () => {
        if ((incoming.state === 'activated' || incoming.state === 'redundant') && !state.newVersion) {
          setAboutUpdate(incoming.state === 'activated' ? 'Установлена последняя версия' : 'Не удалось загрузить — попробуйте позже');
        }
      });
    } else if (!state.newVersion) {
      setAboutUpdate('Установлена последняя версия');
    }
  } catch (e) {
    console.warn(e);
    setAboutUpdate(navigator.onLine ? 'Не удалось проверить' : 'Нет интернета — проверьте позже');
  }
}

async function openAbout() {
  $('about-version').textContent = BUILD.startsWith('__') ? 'для разработки' : BUILD;
  setAboutUpdate(state.newVersion ? 'Есть новая версия' : '—');
  const pages = state.projects.reduce((n, p) => n + idsOf(p).length, 0);
  $('about-counts').textContent = `${state.projects.length} / ${pages}`;
  $('about-storage').textContent = '—';
  $('about').hidden = false;
  try {
    const { usage } = await navigator.storage.estimate();
    $('about-storage').textContent = usage < 1024 * 1024 ? `${Math.round(usage / 1024)} КБ` : `${(usage / 1024 / 1024).toFixed(1)} МБ`;
  } catch { /* браузер не сообщает */ }
}

function setupMenu() {
  const menu = $('menu'), btn = $('btn-menu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.onclick = e => {
    e.stopPropagation();
    menu.hidden = !menu.hidden;
    btn.setAttribute('aria-expanded', String(!menu.hidden));
  };
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  menu.addEventListener('click', async e => {
    const act = e.target.closest('button')?.dataset.act;
    if (!act) return;
    close();
    await ready; // проекты ещё загружаются сразу после запуска
    if (act === 'projects') openProjects();
    else if (act === 'new') newProject();
    else if (act === 'update') { openAbout(); checkForUpdate(); }
    else if (act === 'about') openAbout();
    // 'clear' — свой обработчик у #btn-clear
  });
  $('about-check').onclick = checkForUpdate;
  $('about-reload').onclick = () => { $('about').hidden = true; reloadForUpdate(); };
  $('about-close').onclick = () => { $('about').hidden = true; };
  $('about').addEventListener('click', e => { if (e.target === $('about')) $('about').hidden = true; });
}

// «Обновить»: перезагрузка, когда это безопасно для несохранённой работы.
let updating = false;
async function reloadForUpdate() {
  if (updating) return;
  updating = true;
  try {
    // Дожидаемся записи страниц в память браузера, иначе они пропадут.
    while (state.writes.size) await Promise.all([...state.writes]);
    // Пока ждали, могли открыть редактор, окно PDF или начать обработку.
    if (!$('editor').hidden || !$('sheet').hidden || !$('busy').hidden) {
      toast('Обновление отложено — закройте окно и нажмите «Обновить» ещё раз');
      return;
    }
    // Несохранённые страницы во всех проектах (закрытые с такими — в памяти).
    const all = [...state.pages, ...[...state.memory.values()].flat()];
    const lost = !state.persist ? all.length : all.filter(p => state.unsaved.has(p.id)).length;
    let question = '';
    if (lost) question = `Страниц, не сохранённых в браузере: ${lost}. После обновления они пропадут.`;
    else if (state.dbFailed.size) question = 'Часть изменений (удаление или порядок страниц) не сохранилась и после обновления отменится.';
    if (question && !confirm(question + ' Обновить?')) return;
    location.reload();
  } finally {
    updating = false;
  }
}

// Плашка нужна, если вышла новая версия или база закрыта другой вкладкой.
function showUpdateBanner() {
  $('update').hidden = !(state.newVersion || state.dbClosed);
}

// ---------- Запуск ----------

async function restore() {
  const defaultFilter = settings.get('filter', 'enhance');
  try {
    // Перенос старых данных и чистку отслеживаем только чтобы дождаться их перед
    // перезагрузкой: при сбое ничего не теряется — повторятся при следующем запуске.
    const { projects, current } = await db.loadState({ defaultFilter, onWrite: track });
    state.projects = projects;
    await openProject(current, { remember: false });
    return;
  } catch (e) {
    console.warn('Сохранение страниц недоступно:', e);
    state.persist = false;
    if (e.blocked) toast('Закройте другие вкладки «Сканер PDF» и откройте приложение заново', 8000);
  }
  const p = db.makeProject('Проект 1', defaultFilter);
  state.projects = [p];
  await openProject(p.id, { remember: false });
}

function setup() {
  $('btn-camera').onclick = () => openCamera();
  $('btn-gallery').onclick = () => $('in-gallery').click();
  $('in-camera').onchange = e => {
    const replace = retakeTarget;
    retakeTarget = null;
    addFiles(e.target.files, { fromCamera: true, replace });
    e.target.value = '';
  };
  $('in-camera').addEventListener('cancel', () => { retakeTarget = null; });
  $('in-gallery').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  $('btn-pdf').onclick = openSheet;
  $('btn-clear').onclick = async () => {
    if (!confirm('Удалить все страницы этого проекта?')) return;
    const removed = pageIds();
    state.pages.forEach(p => p.thumbUrl && URL.revokeObjectURL(p.thumbUrl));
    state.pages = [];
    renderList();
    removed.forEach(id => { writeSeq.delete(id); state.unsaved.delete(id); });
    if (state.persist) persistOrder(db.removePages(projectRecord(), removed, otherProjects()));
  };
  setupProjects();
  setupMenu();

  $('pdf-make').onclick = makePdf;
  $('pdf-share').onclick = sharePdf;
  $('pdf-download').onclick = downloadPdf;
  $('pdf-close').onclick = () => { $('sheet').hidden = true; state.pdf = null; };
  $('sheet').addEventListener('click', e => { if (e.target === $('sheet')) $('pdf-close').click(); });
  ['pdf-size', 'pdf-fit', 'pdf-margin', 'pdf-quality', 'pdf-name'].forEach(id => {
    $(id).addEventListener('input', () => { if (state.pdf) resetSheetResult(); });
  });

  setupEditor();

  // Картинки можно перетащить в окно (удобно на компьютере).
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });

  // Другая вкладка обновила приложение и формат базы — здесь сохранять уже нельзя
  // (дальнейшие записи будут неудачными и попадут в учёт несохранённых).
  self.addEventListener('pdf-scanner-db-closed', () => {
    state.dbClosed = true;
    showUpdateBanner();
    toast('Приложение обновилось в другой вкладке — нажмите «Обновить»', 6000);
  });
  $('update-btn').onclick = reloadForUpdate;
  setupUpdates();
  $('version').textContent = 'Версия: ' + (BUILD.startsWith('__') ? 'dev' : BUILD);
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

setup();
// Загрузка проектов; addFiles ждёт её (иначе фото в первую долю секунды терялось).
const ready = restore().catch(e => {
  console.error(e);
  toast('Не удалось открыть проект — перезапустите приложение', 8000);
});
