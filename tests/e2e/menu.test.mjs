// Меню «⋮», окно «О приложении», проверка обновлений вручную, плашка «Обновить» в потоке страницы.
// Регрессия плашки (position: fixed поверх шапки) проверяется и на старом коде:
//   APP_COMMIT=798201a node --test --test-name-pattern='регрессия' tests/e2e/menu.test.mjs
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  reload, addFromGallery, addSigs, checkUpdate, clearEnabled, clickClear, dbProjects, launch, newProject, openApp, pageCount, startServer,
  swReady, waitBannerFlag, waitPages,
} from '../helpers.mjs';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

/** Каждый тест — свой сервер (публикация версий меняет файлы) и свой «телефон». */
async function scenario(fn, build) {
  const server = await startServer({ build });
  try {
    const app = await openApp(browser, server);
    await fn({ server, ...app });
  } finally {
    // Сначала браузер, потом сервер (иначе «connection refused» в консоли).
    for (const c of browser.contexts()) await c.close().catch(() => {});
    await server.close();
  }
}

const menuOpen = page => page.locator('#menu').isVisible();
const expanded = page => page.getAttribute('#btn-menu', 'aria-expanded');
const aboutOpen = page => page.locator('#about').isVisible();

describe('меню «⋮»', () => {
  test('закрыто при запуске; кнопка открывает и закрывает; aria-expanded отражает состояние', () => scenario(async ({ page }) => {
    assert.equal(await menuOpen(page), false);
    assert.equal(await expanded(page), 'false');
    await page.click('#btn-menu');
    assert.equal(await menuOpen(page), true);
    assert.equal(await expanded(page), 'true');
    assert.deepEqual(
      await page.locator('#menu [role="menuitem"]').evaluateAll(els => els.map(e => e.dataset.act)),
      ['projects', 'new', 'merge', 'compress', 'clear', 'update', 'about'],
    );
    await page.click('#btn-menu');
    assert.equal(await menuOpen(page), false);
    assert.equal(await expanded(page), 'false');
  }));

  test('закрывается кликом мимо и клавишей Escape', () => scenario(async ({ page }) => {
    await page.click('#btn-menu');
    await page.mouse.click(200, 500);              // пустая область страницы
    assert.equal(await menuOpen(page), false);
    assert.equal(await expanded(page), 'false');
    await page.click('#btn-menu');
    await page.keyboard.press('Escape');
    assert.equal(await menuOpen(page), false);
    assert.equal(await expanded(page), 'false');
    // клик внутри меню по заголовку/зазору меню не закрывает его
    await page.click('#btn-menu');
    const box = await page.locator('#menu').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + 3); // верхний внутренний отступ
    assert.equal(await menuOpen(page), true);
  }));

  test('клик мимо не вызывает действий под меню (камера не открывается)', () => scenario(async ({ page }) => {
    await page.click('#btn-menu');
    let chooser = false;
    page.on('filechooser', () => { chooser = true; });
    await page.mouse.click(200, 500);
    assert.equal(chooser, false);
  }));

  test('«Проекты» открывает окно проектов', () => scenario(async ({ page }) => {
    await page.click('#btn-menu');
    await page.click('#menu [data-act="projects"]');
    await page.waitForSelector('#projects:not([hidden])');
    assert.equal(await menuOpen(page), false);
  }));

  test('«Новый проект» создаёт пустой проект, старые страницы остаются в прошлом проекте', () => scenario(async ({ page }) => {
    await addSigs(page, [0, 1]);
    await page.click('#btn-menu');
    await page.click('#menu [data-act="new"]');
    await page.waitForFunction(() => document.getElementById('project-name')?.textContent === 'Проект 2');
    assert.equal(await menuOpen(page), false);
    assert.equal(await pageCount(page), 0);
    const db = await dbProjects(page);
    assert.deepEqual(db.projects.map(p => p.name).sort(), ['Проект 1', 'Проект 2']);
    assert.equal(db.pages.length, 2);
  }));

  test('«Очистить проект» отключена, пока страниц нет; появляются страницы — включается', () => scenario(async ({ page }) => {
    assert.equal(await clearEnabled(page), false);
    assert.equal(await page.locator('#btn-clear').isVisible(), true, 'пункт на месте, но отключён (а не скрыт)');
    await page.click('#btn-menu'); // закрыть
    await addSigs(page, [0]);
    assert.equal(await clearEnabled(page), true);
  }));

  test('«Очистить проект»: отказ оставляет страницы, согласие очищает только открытый проект', () => scenario(async ({ page }) => {
    await addSigs(page, [0, 1, 2]);
    await newProject(page);
    await addSigs(page, [3, 4]);
    let message;
    page.once('dialog', d => { message = d.message(); d.dismiss(); });
    await clickClear(page);
    await page.waitForFunction(() => true);
    assert.match(message, /Удалить все страницы этого проекта\?/);
    assert.equal(await pageCount(page), 2);

    page.once('dialog', d => d.accept());
    await clickClear(page);
    await page.waitForSelector('#empty:not([hidden])');
    assert.equal(await menuOpen(page), false);
    // прошлый проект цел
    await page.click('#btn-projects');
    await page.locator('.project-open').nth(1).click();
    await waitPages(page, 3);
    const db = await dbProjects(page);
    assert.equal(db.pages.length, 3, 'фото очищенного проекта удалены, прошлого — на месте');
  }));

  test('«Проверить обновления» открывает окно «О приложении» и проверяет', () => scenario(async ({ page }) => {
    await swReady(page);
    await page.click('#btn-menu');
    await page.click('#menu [data-act="update"]');
    await page.waitForSelector('#about:not([hidden])');
    assert.equal(await menuOpen(page), false);
    await page.waitForFunction(() => document.getElementById('about-update')?.textContent === 'Установлена последняя версия');
  }, 'aaa1111'));

  test('«О приложении» открывает окно', () => scenario(async ({ page }) => {
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    await page.waitForSelector('#about:not([hidden])');
    assert.equal(await menuOpen(page), false);
  }));

  test('меню не пропадает за плашкой «Обновить»: пункты меню под пальцем — сами пункты', () => scenario(async ({ server, page }) => {
    await swReady(page);
    server.publish('bbb2222');
    await checkUpdate(page);
    await page.waitForSelector('#update', { state: 'visible' });
    await page.click('#btn-menu');
    const hits = await page.evaluate(() => [...document.querySelectorAll('#menu [role="menuitem"]')].map(el => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el;
    }));
    assert.deepEqual(hits, [true, true, true, true, true, true, true]);
  }, 'aaa1111'));
});

describe('окно «О приложении»', () => {
  test('собранная версия: показан номер сборки', () => scenario(async ({ page }) => {
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    assert.equal(await page.textContent('#about-version'), 'abc1234');
  }, 'abc1234'));

  test('версия для разработки (без сборки): «для разработки»', () => scenario(async ({ page }) => {
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    assert.equal(await page.textContent('#about-version'), 'для разработки');
  }));

  test('счётчики: число проектов и страниц во всех проектах; обновляются при каждом открытии', () => scenario(async ({ page }) => {
    const open = async () => {
      await page.click('#btn-menu');
      await page.click('#menu [data-act="about"]');
      await page.waitForSelector('#about:not([hidden])');
    };
    await open();
    assert.equal(await page.textContent('#about-counts'), '1 / 0');
    await page.click('#about-close');
    await addSigs(page, [0, 1]);
    await newProject(page);
    await addSigs(page, [2]);
    await open();
    assert.equal(await page.textContent('#about-counts'), '2 / 3');
    await page.click('#about-close');
    await page.waitForSelector('#about[hidden]', { state: 'attached' });
  }));

  test('сколько занято на телефоне: показано значение в КБ или МБ', () => scenario(async ({ page }) => {
    await addFromGallery(page, ['white.jpg']);
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    await page.waitForFunction(() => /^\d+(\.\d)? (КБ|МБ)$/.test(document.getElementById('about-storage')?.textContent));
  }));

  test('закрывается кнопкой «Закрыть» и кликом по подложке; кнопка проверки не закрывает окно', () => scenario(async ({ page }) => {
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    await page.click('#about-close');
    assert.equal(await aboutOpen(page), false);
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    await page.mouse.click(5, 5);
    assert.equal(await aboutOpen(page), false);
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    await page.click('#about-check');
    assert.equal(await aboutOpen(page), true);
  }));

  test('ссылка на исходный код ведёт на GitHub и открывается в новой вкладке', () => scenario(async ({ page }) => {
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    const link = page.locator('#about a');
    assert.equal(await link.getAttribute('href'), 'https://github.com/umnovI/pdf-scanner');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match(await link.getAttribute('rel'), /noopener/);
  }));

  test('«Проверить обновления» без новой версии: «Установлена последняя версия», плашки нет', () => scenario(async ({ page, errors }) => {
    await swReady(page);
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    assert.equal(await page.textContent('#about-update'), '—');
    await page.click('#about-check');
    await page.waitForFunction(() => document.getElementById('about-update')?.textContent === 'Установлена последняя версия');
    assert.equal(await page.locator('#update').isVisible(), false);
    assert.deepEqual(errors, []);
  }, 'aaa1111'));

  test('«Проверить обновления» после публикации: текст с новой версией, плашка видна после закрытия окна', () => scenario(async ({ server, page, errors }) => {
    await swReady(page);
    await addSigs(page, [0]);
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    server.publish('def5678');
    await page.click('#about-check');
    await page.waitForFunction(() => /def5678/.test(document.getElementById('about-update')?.textContent));
    // Регрессия: окно просило нажать «Обновить» вверху, а плашка под окном скрыта —
    // теперь кнопка прямо в окне.
    assert.equal(await page.locator('#about-reload').isVisible(), true, 'в окне есть «Обновить сейчас»');
    assert.equal(await page.locator('#update').isVisible(), false, 'пока открыто окно, плашка скрыта');
    await page.click('#about-close');
    await page.waitForSelector('#update', { state: 'visible' });
    // повторное открытие напоминает о новой версии
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    assert.match(await page.textContent('#about-update'), /новая версия/);
    await page.click('#about-close');
    // и «Обновить» работает: страницы на месте
    await page.click('#update-btn');
    await page.waitForFunction(() => document.getElementById('version')?.textContent === 'Версия: def5678');
    await waitPages(page, 1);
    assert.deepEqual(errors, []);
  }, 'abc1234'));

  test('регрессия: «Обновить сейчас» в окне «О приложении» загружает новую версию', () => scenario(async ({ server, page }) => {
    await swReady(page);
    await addSigs(page, [0]);
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    assert.equal(await page.locator('#about-reload').isVisible(), false, 'без новой версии кнопки нет');
    server.publish('def5678');
    await page.click('#about-check');
    await page.waitForSelector('#about-reload', { state: 'visible', timeout: 15000 });
    await page.click('#about-reload');
    await page.waitForFunction(() => document.getElementById('version')?.textContent === 'Версия: def5678');
    await waitPages(page, 1);
  }, 'abc1234'));

    test('пункт меню «Проверить обновления» сразу находит новую версию', () => scenario(async ({ server, page }) => {
    await swReady(page);
    server.publish('def5678');
    await page.click('#btn-menu');
    await page.click('#menu [data-act="update"]');
    await page.waitForFunction(() => /def5678/.test(document.getElementById('about-update')?.textContent));
    await page.click('#about-close');
    await page.waitForSelector('#update', { state: 'visible' });
  }, 'abc1234'));
});

describe('плашка «Обновить» не перекрывает шапку', () => {
  /** Границы шапки и плашки на экране. */
  const rects = page => page.evaluate(() => {
    const r = sel => { const b = document.querySelector(sel).getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; };
    return { topbar: r('.topbar'), update: r('#update') };
  });
  /** Каждая видимая кнопка шапки действительно получает нажатие в центре (её не закрывает другой элемент). */
  const topbarHits = page => page.evaluate(() => [...document.querySelectorAll('.topbar button')]
    .filter(b => b.getClientRects().length)
    .map(b => {
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { id: b.id, hit: top?.closest('button') === b };
    }));

  async function withBanner(fn) {
    await scenario(async ctx => {
      const { server, page } = ctx;
      await addFromGallery(page, ['white.jpg']); // у старой версии «Очистить» появляется в шапке только со страницами
      await swReady(page);
      await reload(page); // обычный запуск: вкладка сразу под управлением воркера
      await waitPages(page, 1);
      await swReady(page);
      server.publish('bbb2222');
      await checkUpdate(page);
      await page.waitForSelector('#update', { state: 'visible' });
      await fn(ctx);
    }, 'aaa1111');
  }

  test('регрессия 8: плашка под шапкой, а не поверх неё (ошибка: position: fixed; поверх шапки не нажимались кнопки)', () => withBanner(async ({ page }) => {
    const { topbar, update } = await rects(page);
    assert.ok(update.top >= topbar.bottom - 0.5, `плашка (${update.top}…${update.bottom}) заходит на шапку (${topbar.top}…${topbar.bottom})`);
    assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('update')).position), 'static');
  }));

  test('регрессия 8б: все кнопки шапки получают нажатие, пока плашка видна', () => withBanner(async ({ page }) => {
    const hits = await topbarHits(page);
    assert.ok(hits.length >= 1);
    for (const h of hits) assert.ok(h.hit, `кнопка «${h.id}» закрыта другим элементом`);
  }));

  test('кнопки проектов и меню нажимаются при видимой плашке', () => withBanner(async ({ page }) => {
    await page.click('#btn-menu');
    assert.equal(await menuOpen(page), true);
    await page.click('#btn-menu');
    await page.click('#btn-projects');
    await page.waitForSelector('#projects:not([hidden])');
  }));

  test('плашка не сдвигает и не перекрывает список страниц и нижние кнопки', () => withBanner(async ({ page }) => {
    const r = await page.evaluate(() => {
      const b = sel => document.querySelector(sel).getBoundingClientRect();
      const u = b('#update'), pg = b('.page'), bar = b('.bottombar');
      return { updateBottom: u.bottom, pageTop: pg.top, barTop: bar.top, pageBottom: pg.bottom };
    });
    assert.ok(r.pageTop >= r.updateBottom - 0.5, 'список начинается под плашкой');
    assert.ok(r.barTop > r.updateBottom, 'нижняя панель ниже плашки');
  }));

  test('плашка скрыта при открытых окнях «Проекты», «О приложении», «Сохранить PDF», редакторе и обработке', () => withBanner(async ({ page }) => {
    for (const [open, close, win] of [
      ['#btn-projects', '#projects-close', '#projects'],
      ['#btn-pdf', '#pdf-close', '#sheet'],
    ]) {
      await page.click(open);
      assert.equal(await page.locator('#update').isVisible(), false, `поверх ${win} плашки быть не должно`);
      await page.click(close);
      await page.waitForSelector('#update', { state: 'visible' });
    }
    await page.click('#btn-menu');
    await page.click('#menu [data-act="about"]');
    assert.equal(await page.locator('#update').isVisible(), false);
    await page.click('#about-close');
    await page.waitForSelector('#update', { state: 'visible' });
    await waitBannerFlag(page);
  }));
});

describe('меню сразу после запуска', () => {
  // Регрессия: «Новый проект» до окончания загрузки создавал проект, но загрузка
  // текущего проекта тут же перекрывала его — открывался старый.
  test('регрессия: «Новый проект» сразу после запуска открывает новый проект', async () => {
    const server = await startServer();
    try {
      const { phone, slowDbOpen } = await import('../helpers.mjs');
      const { page, ctx } = await phone(browser);
      await slowDbOpen(ctx, 1500); // загрузка проекта точно не успеет
      await page.goto(server.url);
      await page.click('#btn-menu');
      await page.click('#menu [data-act="new"]');
      await page.waitForFunction(() => document.getElementById('project-name')?.textContent === 'Проект 2');
      // Через секунду всё ещё открыт новый проект (загрузка не перекрыла его).
      await page.waitForTimeout(1500);
      assert.equal(await page.textContent('#project-name'), 'Проект 2');
    } finally {
      for (const c of browser.contexts()) await c.close().catch(() => {});
      await server.close();
    }
  });
});
