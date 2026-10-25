// Проекты: новый проект, переключение, переименование, удаление, счётчики и миниатюры,
// фильтр проекта, имя PDF, несохранённые страницы, работа без IndexedDB.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  activeFilter, addFromCamera, addFromGallery, addSigs, closeProjects, dbProjects, dbRecords, editorDone, idbFailInit,
  launch, makePdf, newProject, openApp, openEditor, openProjectAt, openProjects, pageCount, pageSigs, pageStamp,
  projectRows, startServer, swReady, waitCurrentSaved, waitName, waitPages,
} from '../helpers.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launch(); });
after(async () => { await browser?.close(); await server?.close(); });

/** Ответ на ближайший диалог (confirm/prompt): accept — true/строка, false — отмена. Промис с текстом диалога. */
function answer(page, accept = true) {
  return new Promise(resolve => {
    page.once('dialog', async d => {
      const seen = { message: d.message(), type: d.type(), defaultValue: d.defaultValue() };
      if (accept === false) await d.dismiss(); else await d.accept(typeof accept === 'string' ? accept : undefined);
      resolve(seen);
    });
  });
}

/** Действие над строкой окна «Проекты» (с 1, новые сверху): '.project-rename' / '.project-delete'. */
async function rowAction(page, n, selector, reply) {
  if (await page.locator('#projects').isHidden()) await openProjects(page);
  const seen = answer(page, reply);
  await page.locator('.project').nth(n - 1).locator(selector).click();
  return seen;
}

const names = async page => (await projectRows(page)).map(r => r.title);

describe('новый проект и переключение', () => {
  test('«Новый проект» пуст; старый остаётся с теми же страницами и порядком', async () => {
    const { page, errors } = await openApp(browser, server);
    await addSigs(page, [2, 0, 1]);
    await newProject(page);
    await waitName(page, 'Проект 2');
    assert.equal(await pageCount(page), 0);
    assert.equal(await page.locator('#empty').isVisible(), true);
    assert.equal(await page.locator('#btn-pdf').isDisabled(), true);
    assert.match(await page.textContent('#toast'), /Создан «Проект 2»/);

    await openProjects(page);
    const rows = await projectRows(page);
    assert.deepEqual(rows.map(r => r.title), ['Проект 2', 'Проект 1']);
    assert.match(rows[0].meta, /^0 стр\./);
    assert.match(rows[1].meta, /^3 стр\./);
    assert.equal(rows[0].current, true);
    assert.equal(rows[1].current, false);

    await page.locator('.project-open').nth(1).click();
    await page.waitForSelector('#projects[hidden]', { state: 'attached' });
    await waitPages(page, 3);
    assert.deepEqual(await pageSigs(page), [2, 0, 1]);
    assert.equal(await page.textContent('#project-name'), 'Проект 1');
    assert.deepEqual(errors, []);
  });

  test('нажатие на уже открытый проект просто закрывает окно, страницы не перезагружаются', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1]);
    await page.evaluate(() => { window.marker = document.querySelector('.page img'); });
    await openProjectAt(page, 1);
    assert.deepEqual(await pageSigs(page), [0, 1]);
    assert.equal(await page.evaluate(() => window.marker === document.querySelector('.page img')), true);
  });

  test('перезагрузка открывает последний открытый проект', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1]);
    await newProject(page);                      // Проект 2 — пустой, открыт
    await addSigs(page, [3]);
    await page.reload();
    await waitName(page, 'Проект 2');
    await waitPages(page, 1);
    assert.deepEqual(await pageSigs(page), [3]);

    await openProjectAt(page, 2);                // вернулись в Проект 1
    await waitPages(page, 2);
    await waitCurrentSaved(page, 'Проект 1');
    await page.reload();
    await waitName(page, 'Проект 1');
    await waitPages(page, 2);
    assert.deepEqual(await pageSigs(page), [0, 1]);
  });

  test('пустой новый проект переживает перезагрузку и остаётся открытым', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0]);
    await newProject(page);
    await page.reload();
    await waitName(page, 'Проект 2');
    assert.equal(await pageCount(page), 0);
    assert.equal((await dbProjects(page)).projects.length, 2);
  });

  test('меню «Проекты»: кнопка в шапке показывает название и открывает список; «Закрыть» и клик мимо закрывают', async () => {
    const { page } = await openApp(browser, server);
    await waitName(page, 'Проект 1');
    await openProjects(page);
    await closeProjects(page);
    await openProjects(page);
    await page.mouse.click(5, 5); // подложка окна
    await page.waitForSelector('#projects[hidden]', { state: 'attached' });
  });

  test('работа в нескольких проектах: страницы не смешиваются и сохраняются раздельно', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1]);
    await newProject(page);
    await addSigs(page, [2, 3, 4]);
    await openProjectAt(page, 2);
    await waitPages(page, 2);
    await addSigs(page, [5]);
    assert.deepEqual(await pageSigs(page), [0, 1, 5]);
    await openProjectAt(page, 1);
    await waitPages(page, 3);
    assert.deepEqual(await pageSigs(page), [2, 3, 4]);
    await page.reload();
    await waitName(page, 'Проект 2');
    await waitPages(page, 3);
    await openProjectAt(page, 2);
    await waitPages(page, 3);
    assert.deepEqual(await pageSigs(page), [0, 1, 5]);
  });
});

describe('переименование', () => {
  test('prompt с текущим названием; новое название в шапке, списке и после перезагрузки', async () => {
    const { page, errors } = await openApp(browser, server);
    await waitName(page, 'Проект 1');
    const seen = await rowAction(page, 1, '.project-rename', 'Отпуск 2026');
    await waitName(page, 'Отпуск 2026');
    assert.equal(seen.type, 'prompt');
    assert.equal(seen.defaultValue, 'Проект 1');
    assert.deepEqual(await names(page), ['Отпуск 2026']);
    await page.reload();
    await waitName(page, 'Отпуск 2026');
    assert.deepEqual(errors, []);
  });

  test('отмена, пустое и прежнее название ничего не меняют; пробелы по краям обрезаются', async () => {
    const { page } = await openApp(browser, server);
    await waitName(page, 'Проект 1');
    await rowAction(page, 1, '.project-rename', false);
    await rowAction(page, 1, '.project-rename', '   ');
    await rowAction(page, 1, '.project-rename', 'Проект 1');
    assert.deepEqual(await names(page), ['Проект 1']);
    await rowAction(page, 1, '.project-rename', '  Дача  ');
    await waitName(page, 'Дача');
  });

  test('переименование закрытого проекта не меняет шапку', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0]);
    await newProject(page);
    await rowAction(page, 2, '.project-rename', 'Старый');
    assert.deepEqual(await names(page), ['Проект 2', 'Старый']);
    assert.equal(await page.textContent('#project-name'), 'Проект 2');
    await closeProjects(page);
    await page.reload();
    await waitName(page, 'Проект 2');
    await openProjects(page);
    assert.deepEqual(await names(page), ['Проект 2', 'Старый']);
  });

  test('название попадает в имя PDF', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0]);
    await rowAction(page, 1, '.project-rename', 'Договор');
    await waitName(page, 'Договор');
    await closeProjects(page);
    const { filename } = await makePdf(page);
    assert.match(filename, /^Договор \d{4}-\d\d-\d\d \d\d-\d\d\.pdf$/);
  });
});

describe('удаление', () => {
  test('подтверждение с названием и числом страниц; отказ ничего не удаляет', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1, 2]);
    const seen = await rowAction(page, 1, '.project-delete', false);
    assert.equal(seen.message, 'Удалить проект «Проект 1» и его страницы (3)?');
    assert.equal(await pageCount(page), 3);
    assert.deepEqual(await names(page), ['Проект 1']);
  });

  test('удаление открытого проекта: открывается другой, его страницы на месте; фото удалённого проекта удалены из базы', async () => {
    const { page, errors } = await openApp(browser, server);
    await addSigs(page, [0, 1]);
    await newProject(page);
    await addSigs(page, [2, 3, 4]);
    await rowAction(page, 1, '.project-delete');  // открытый Проект 2
    await waitPages(page, 2);
    assert.deepEqual(await pageSigs(page), [0, 1]);
    assert.equal(await page.textContent('#project-name'), 'Проект 1');
    assert.deepEqual(await names(page), ['Проект 1']);
    await page.waitForFunction(async () => (await window.raw.all('pages')).length === 2);
    await closeProjects(page);
    await waitCurrentSaved(page, 'Проект 1');
    await page.reload();
    await waitName(page, 'Проект 1');
    await waitPages(page, 2);
    const db = await dbProjects(page);
    assert.equal(db.projects.length, 1);
    assert.equal(db.pages.length, 2);
    assert.deepEqual(errors, []);
  });

  test('удалён последний проект: создаётся пустой, приложение работает, после перезагрузки он единственный', async () => {
    const { page, errors } = await openApp(browser, server);
    await addSigs(page, [0, 1]);
    await rowAction(page, 1, '.project-delete');
    await page.waitForSelector('#empty:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#project-list .project-title')?.textContent === 'Проект 2');
    assert.equal(await pageCount(page), 0);
    const rows = await projectRows(page);
    assert.equal(rows.length, 1);
    assert.match(rows[0].title, /^Проект \d+$/);
    assert.match(rows[0].meta, /^0 стр\./);
    assert.equal(rows[0].current, true);
    assert.equal(await page.textContent('#project-name'), rows[0].title);
    await closeProjects(page);
    await addSigs(page, [4]);
    await page.reload();
    await waitPages(page, 1);
    assert.deepEqual(await pageSigs(page), [4]);
    const db = await dbProjects(page);
    assert.equal(db.projects.length, 1);
    assert.equal(db.pages.length, 1, 'старые фото удалены');
    assert.deepEqual(errors, []);
  });

  test('удаление закрытого проекта не трогает открытый', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1]);
    await newProject(page);
    await addSigs(page, [2]);
    const marker = await page.evaluate(() => { window.marker = document.querySelector('.page img'); return true; });
    assert.ok(marker);
    const seen = await rowAction(page, 2, '.project-delete');       // закрытый Проект 1
    assert.match(seen.message, /«Проект 1».*\(2\)/);
    await page.waitForFunction(() => document.querySelectorAll('#project-list .project').length === 1);
    assert.equal(await page.evaluate(() => window.marker === document.querySelector('.page img')), true, 'страницы открытого проекта не перерисованы');
    assert.deepEqual(await pageSigs(page), [2]);
    assert.equal(await page.textContent('#project-name'), 'Проект 2');
    await page.waitForFunction(async () => (await window.raw.all('pages')).length === 1);
    const db = await dbProjects(page);
    assert.deepEqual(db.projects.map(p => p.name), ['Проект 2']);
    await closeProjects(page);
    await page.reload();
    await waitPages(page, 1);
    assert.deepEqual(await pageSigs(page), [2]);
  });

  test('имя нового проекта не повторяет существующие после удаления', async () => {
    const { page } = await openApp(browser, server);
    await newProject(page);                       // Проект 2
    await newProject(page);                       // Проект 3
    await rowAction(page, 2, '.project-delete');  // удалили Проект 2
    await closeProjects(page);
    await newProject(page);
    await openProjects(page);
    const list = await names(page);
    assert.equal(new Set(list).size, list.length, `названия повторяются: ${list}`);
  });
});

describe('список проектов: счётчики и миниатюры', () => {
  test('число страниц и миниатюры первых страниц, в том числе у закрытого проекта после перезагрузки', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [2, 0, 1]);               // Проект 1: первая страница — пропорция 1.5
    await newProject(page);
    await addSigs(page, [4]);                     // Проект 2: пропорция 2
    await newProject(page);                       // Проект 3: пусто
    await page.reload();                          // миниатюры закрытых проектов читаются из базы
    await waitName(page, 'Проект 3');
    await openProjects(page);
    await page.waitForFunction(() => document.querySelectorAll('#project-list .project-thumb img:not([hidden])').length === 2);
    const rows = await projectRows(page);
    assert.deepEqual(rows.map(r => r.title), ['Проект 3', 'Проект 2', 'Проект 1']);
    assert.match(rows[0].meta, /^0 стр\./);
    assert.match(rows[1].meta, /^1 стр\./);
    assert.match(rows[2].meta, /^3 стр\./);
    assert.equal(rows[0].thumb, null, 'у пустого проекта миниатюры нет');
    const ratio = t => t.h / t.w;
    assert.ok(Math.abs(ratio(rows[1].thumb) - 2) < 0.05, `миниатюра Проекта 2: ${JSON.stringify(rows[1].thumb)}`);
    assert.ok(Math.abs(ratio(rows[2].thumb) - 1.5) < 0.05, `миниатюра Проекта 1: ${JSON.stringify(rows[2].thumb)}`);
    assert.match(rows[0].meta, /открыт/);
    assert.doesNotMatch(rows[1].meta, /открыт/);
  });

  test('счётчик открытого проекта обновляется после добавления и удаления страниц', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0, 1]);
    await openProjects(page);
    assert.match((await projectRows(page))[0].meta, /^2 стр\./);
    await closeProjects(page);
    await addSigs(page, [2]);
    page.once('dialog', d => d.accept());
    await page.locator('.page').first().locator('.del').click();
    await waitPages(page, 2);
    await openProjects(page);
    const [row] = await projectRows(page);
    assert.match(row.meta, /^2 стр\./);
    assert.ok(row.thumb, 'миниатюра первой страницы');
    assert.ok(Math.abs(row.thumb.h / row.thumb.w - 1.25) < 0.05, 'миниатюра — новая первая страница');
  });
});

describe('фильтр проекта', () => {
  const chooseDoc = async page => {
    await page.click('#ed-filters [data-f="doc"]');
    await editorDone(page);
  };

  test('выбранный в редакторе фильтр получают следующие снимки камерой и фото из галереи', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    assert.equal(await activeFilter(page), 'enhance', 'по умолчанию — «Улучшить»');
    await chooseDoc(page);
    await waitPages(page, 1);

    await addFromCamera(page, 'school.jpg');
    assert.equal(await activeFilter(page), 'doc', 'следующий снимок камерой — «Документ»');
    await page.click('#ed-cancel');
    await addFromGallery(page, ['white.jpg', 'landscape.jpg']);
    assert.deepEqual((await dbRecords(page)).map(r => r.filter), ['doc', 'doc', 'doc', 'doc']);
    await page.reload();
    await waitPages(page, 4);
    await openEditor(page, 4);
    assert.equal(await activeFilter(page), 'doc');
    await page.click('#ed-cancel');
  });

  test('фильтр запоминается в проекте и после перезагрузки', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    await chooseDoc(page);
    await waitPages(page, 1);
    await page.reload();
    await waitPages(page, 1);
    await addFromGallery(page, ['school.jpg']);
    assert.equal((await dbRecords(page))[1].filter, 'doc');
    assert.equal((await dbProjects(page)).projects[0].filter, 'doc');
  });

  test('побеждает последний выбранный фильтр; правка только углов фильтр проекта не меняет', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    await chooseDoc(page);
    await waitPages(page, 1);
    await addFromGallery(page, ['white.jpg']);
    await openEditor(page, 2);
    await page.click('#ed-filters [data-f="bw"]');
    await editorDone(page);                        // теперь фильтр проекта — «Ч/Б»
    await openEditor(page, 1);
    await page.click('#ed-full');                  // только углы
    await editorDone(page);
    await addFromGallery(page, ['white.jpg']);
    assert.deepEqual((await dbRecords(page)).map(r => r.filter), ['doc', 'bw', 'bw']);
  });

  test('новый проект наследует фильтр открытого', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    await chooseDoc(page);
    await waitPages(page, 1);
    await newProject(page);
    await addFromGallery(page, ['white.jpg']);
    assert.equal((await dbRecords(page))[0].filter, 'doc');
    assert.equal((await dbProjects(page)).projects.find(p => p.name === 'Проект 2').filter, 'doc');
  });

  test('у каждого проекта свой фильтр, он сохраняется при переключении и перезагрузке', async () => {
    const { page } = await openApp(browser, server);
    await addFromCamera(page, 'white.jpg');
    await chooseDoc(page);                         // Проект 1: «Документ»
    await waitPages(page, 1);
    await newProject(page);
    await addFromCamera(page, 'white.jpg');
    await page.click('#ed-filters [data-f="bw"]');
    await editorDone(page);                        // Проект 2: «Ч/Б»
    await waitPages(page, 1);

    await openProjectAt(page, 2);                  // обратно в Проект 1
    await waitPages(page, 1);
    await addFromCamera(page, 'school.jpg');
    assert.equal(await activeFilter(page), 'doc', 'Проект 1 — «Документ»');
    await page.click('#ed-cancel');

    await openProjectAt(page, 1);                  // Проект 2
    await waitPages(page, 1);
    await addFromCamera(page, 'school.jpg');
    assert.equal(await activeFilter(page), 'bw', 'Проект 2 — «Ч/Б»');
    await page.click('#ed-cancel');

    await waitCurrentSaved(page, 'Проект 2');
    await page.reload();
    await waitName(page, 'Проект 2');
    await waitPages(page, 2);
    await addFromGallery(page, ['white.jpg']);
    assert.equal((await dbRecords(page)).at(-1).filter, 'bw');
  });
});

describe('имя PDF', () => {
  test('«<название проекта> ГГГГ-ММ-ДД ЧЧ-ММ»: поле в окне и имя скачанного файла', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0]);
    await newProject(page);
    await addSigs(page, [1]);
    await rowAction(page, 1, '.project-rename', 'Анкета №3');
    await waitName(page, 'Анкета №3');
    await closeProjects(page);
    const before = await pageStamp(page);
    await page.click('#btn-pdf');
    const field = await page.inputValue('#pdf-name');
    const after = await pageStamp(page);
    assert.ok([`Анкета №3 ${before}`, `Анкета №3 ${after}`].includes(field), `имя в окне: «${field}»`);
    await page.click('#pdf-close');
    const { filename } = await makePdf(page);
    assert.match(filename, /^Анкета №3 \d{4}-\d\d-\d\d \d\d-\d\d\.pdf$/);
  });

  test('название с недопустимыми символами: в имени файла они заменяются', async () => {
    const { page } = await openApp(browser, server);
    await addSigs(page, [0]);
    await rowAction(page, 1, '.project-rename', 'a/b:c');
    await closeProjects(page);
    const { filename } = await makePdf(page);
    assert.match(filename, /^a_b_c \d{4}-\d\d-\d\d \d\d-\d\d\.pdf$/);
  });
});

describe('несохранённые страницы', () => {
  /** Приложение с версией aaa1111 и подменой put (сбой включается через window.__idbFail). */
  async function scenario(fn) {
    const srv = await startServer({ build: 'aaa1111' });
    try {
      const app = await openApp(browser, srv, { init: [idbFailInit] });
      await fn({ srv, ...app });
    } finally { await srv.close(); }
  }
  const failOn = (page, mode = 'throw') => page.evaluate(m => { window.__idbFail = { put: m }; }, mode);
  const failOff = page => page.evaluate(() => { window.__idbFail = {}; });
  async function clickConfirm(page, selector, accept = false) {
    const seen = answer(page, accept);
    await page.click(selector);
    return seen;
  }

  test('сбой записи: страница не теряется при переключении проектов туда и обратно', () => scenario(async ({ page, errors }) => {
    await addSigs(page, [0]);                      // сохранена
    await failOn(page);
    await addSigs(page, [1]);                      // на экране есть, в базу не записалась
    await failOff(page);
    await newProject(page);                        // Проект 2
    await addSigs(page, [2]);
    await openProjectAt(page, 2);                  // обратно в Проект 1
    await waitPages(page, 2);
    assert.deepEqual(await pageSigs(page), [0, 1], 'несохранённая страница вернулась из памяти');
    await openProjects(page);
    assert.match((await projectRows(page))[1].meta, /^2 стр\./);
    await closeProjects(page);
    await openProjectAt(page, 1);                  // и снова в Проект 2
    await waitPages(page, 1);
    assert.deepEqual(await pageSigs(page), [2]);
    void errors;
  }));

  test('несохранённая страница закрытого проекта учитывается в подтверждении «Обновить»', () => scenario(async ({ srv, page }) => {
    await swReady(page);
    await addSigs(page, [0]);
    await failOn(page);
    await addSigs(page, [1]);                      // несохранённая, в Проекте 1
    await failOff(page);
    await newProject(page);                        // Проект 1 закрыт, страница в памяти
    await addSigs(page, [2]);                      // сохранена
    srv.publish('bbb2222');
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
    await page.waitForSelector('#update', { state: 'visible' });
    await page.evaluate(() => { window.marker = 1; });
    const seen = await clickConfirm(page, '#update-btn', false);
    assert.match(seen.message, /Страниц, не сохранённых в браузере: 1\./);
    assert.equal(await page.evaluate(() => window.marker), 1, 'без согласия перезагрузки нет');
    // сохранённые страницы и проекты не пострадали
    assert.equal(await pageCount(page), 1);
    await openProjectAt(page, 2);
    await waitPages(page, 2);
    assert.deepEqual(await pageSigs(page), [0, 1]);
  }));

  test('несохранённая страница в открытом проекте после переключения и возврата считается в подтверждении один раз', { todo: 'ошибка приложения: проект открыт из state.memory, и reloadForUpdate считает его страницы дважды (app.js, reloadForUpdate)' }, () => scenario(async ({ srv, page }) => {
    await swReady(page);
    await failOn(page);
    await addSigs(page, [0]);
    await failOff(page);
    await newProject(page);
    await openProjectAt(page, 2);
    await waitPages(page, 1);
    srv.publish('bbb2222');
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
    await page.waitForSelector('#update', { state: 'visible' });
    const seen = await clickConfirm(page, '#update-btn', false);
    assert.match(seen.message, /: 1\./);
  }));

  test('правка несохранённой страницы, когда запись снова работает, сохраняет её', () => scenario(async ({ page }) => {
    await addSigs(page, [0]);
    await failOn(page);
    await addSigs(page, [1]);
    await failOff(page);
    await newProject(page);
    await openProjectAt(page, 2);
    await waitPages(page, 2);
    await openEditor(page, 2);
    await page.click('#ed-filters [data-f="gray"]');
    await editorDone(page);
    assert.equal((await dbRecords(page)).length, 2, 'вторая страница теперь в базе');
    await page.reload();
    await waitPages(page, 2);
  }));

  test('сбой создания проекта: показано сообщение, текущий проект остаётся', () => scenario(async ({ page }) => {
    await addSigs(page, [0]);
    await failOn(page);
    await openProjects(page);
    await page.click('#project-new');
    await page.waitForFunction(() => /Не удалось создать проект/.test(document.getElementById('toast').textContent));
    assert.equal(await page.textContent('#project-name'), 'Проект 1');
    assert.equal(await pageCount(page), 1);
    assert.deepEqual(await names(page), ['Проект 1']);
  }));
});

describe('без IndexedDB', () => {
  const noIdb = () => { indexedDB.open = () => { throw new DOMException('IndexedDB недоступна', 'SecurityError'); }; };

  test('проекты работают в памяти: создание, переключение, переименование, удаление', async () => {
    const { page, errors } = await openApp(browser, server, { init: [noIdb] });
    await waitName(page, 'Проект 1');
    await addSigs(page, [0, 1]);
    await newProject(page);
    await waitName(page, 'Проект 2');
    assert.equal(await pageCount(page), 0);
    await addSigs(page, [2]);

    await openProjects(page);
    const rows = await projectRows(page);
    assert.deepEqual(rows.map(r => r.title), ['Проект 2', 'Проект 1']);
    assert.match(rows[1].meta, /^2 стр\./);
    assert.ok(rows[1].thumb, 'миниатюра из памяти');
    await page.locator('.project-open').nth(1).click();
    await waitPages(page, 2);
    assert.deepEqual(await pageSigs(page), [0, 1]);

    await rowAction(page, 2, '.project-rename', 'Первый');   // открыт «Проект 1» — он второй в списке
    await waitName(page, 'Первый');
    await rowAction(page, 1, '.project-delete');   // «Проект 2» (закрытый)
    await page.waitForFunction(() => document.querySelectorAll('#project-list .project').length === 1);
    assert.deepEqual(await pageSigs(page), [0, 1]);
    await rowAction(page, 1, '.project-delete');   // последний
    await page.waitForSelector('#empty:not([hidden])');
    assert.equal((await projectRows(page)).length, 1);
    assert.deepEqual(errors, []);
  });

  test('«Обновить» считает все страницы всех проектов несохранёнными', async () => {
    const srv = await startServer({ build: 'aaa1111' });
    try {
      const { page } = await openApp(browser, srv, { init: [noIdb] });
      await swReady(page);
      await addSigs(page, [0, 1]);
      await newProject(page);
      await addSigs(page, [2]);
      srv.publish('bbb2222');
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
      await page.waitForSelector('#update', { state: 'visible' });
      const asked = answer(page, false);
      await page.click('#update-btn');
      const seen = await asked;
      assert.match(seen.message, /Страниц, не сохранённых в браузере: 3\./);
    } finally { await srv.close(); }
  });
});
