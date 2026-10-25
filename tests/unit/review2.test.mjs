// Регрессии второго круга код-ревью (Node): слои, проверка страниц без /Count, ленивые именованные ссылки,
// трейлер при восстановлении.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  PdfDoc, Ref, Stream, blobBytes, fx, handPdf, latin1, objStmPdf, offsetOf, openDoc, pageMarks, patchXref,
} from '../pdfutil.mjs';
import { mergePdfs } from '../../app/pdftools.js';

const spyRebuild = async fn => {
  const orig = PdfDoc.prototype.rebuildXref;
  let n = 0;
  PdfDoc.prototype.rebuildXref = function (...a) { n++; return orig.apply(this, a); };
  try { return { value: await fn(), rebuilt: n }; } finally { PdfDoc.prototype.rebuildXref = orig; }
};

describe('1. слои при объединении: /BaseState, /AS', () => {
  /** Файл с тремя слоями: <tag>-a, <tag>-b, <tag>-wm. d — тело словаря /D (строка со ссылками 40/41/42). */
  const oc = (tag, d, { ocgs = '[40 0 R 41 0 R 42 0 R]' } = {}) => handPdf([{ text: `${tag}-P1` }], {
    catalogExtra: `/OCProperties << ${ocgs ? `/OCGs ${ocgs}` : ''} /D << ${d} >> >>`,
    extraObjs: {
      40: `<< /Type /OCG /Name (${tag}-a) >>`, 41: `<< /Type /OCG /Name (${tag}-b) >>`, 42: `<< /Type /OCG /Name (${tag}-wm) >>`,
    },
  });
  const names = async (doc, list) => Promise.all((list || []).map(async r => latin1((await doc.get(r)).get('Name').bytes)));
  const merged = async (...files) => {
    const doc = await openDoc((await mergePdfs(files)).blob);
    const root = await doc.get(doc.trailer.get('Root'));
    const props = await doc.get(root.get('OCProperties'));
    const D = await doc.get(props.get('D'));
    return { doc, props, D, ocgs: await doc.get(props.get('OCGs')) };
  };

  test('у второго файла /BaseState /OFF: его слои, не перечисленные в /ON, выключены', async () => {
    const r = await merged(oc('A', '/OFF [41 0 R]'), oc('B', '/BaseState /OFF /ON [40 0 R]'));
    assert.deepEqual((await names(r.doc, r.D.get('OFF'))).sort(), ['A-b', 'B-b', 'B-wm']);
    assert.ok(!(r.D.get('BaseState') && r.D.get('BaseState').n === 'OFF'), 'общий BaseState не OFF');
  });

  test('у первого /BaseState /OFF, у второго по умолчанию: слои второго остаются видимыми', async () => {
    const r = await merged(oc('A', '/BaseState /OFF /ON [40 0 R]'), oc('B', ''));
    const off = await names(r.doc, r.D.get('OFF'));
    assert.deepEqual(off.sort(), ['A-b', 'A-wm']);
    assert.ok(!off.some(n => n.startsWith('B-')), 'слои второго файла не выключены');
    assert.notEqual(r.D.get('BaseState')?.n, 'OFF', 'иначе все слои, не упомянутые в /ON, выключились бы');
  });

  test('/AS обоих файлов складываются (водяной знак «только печать» второго сохраняется)', async () => {
    const as = (ev, g) => `/AS [<< /Event /${ev} /Category [/${ev}] /OCGs [${g} 0 R] >>]`;
    const r = await merged(oc('A', `/OFF [42 0 R] ${as('View', 42)}`), oc('B', `/OFF [42 0 R] ${as('Print', 42)}`));
    const list = await Promise.all(r.D.get('AS').map(a => r.doc.get(a)));
    assert.equal(list.length, 2);
    assert.deepEqual(list.map(a => a.get('Event').n).sort(), ['Print', 'View']);
    const wm = await Promise.all(list.map(async a => names(r.doc, a.get('OCGs'))));
    assert.deepEqual(wm.flat().sort(), ['A-wm', 'B-wm']);
  });

  test('/OCProperties без /OCGs не даёт /OCGs [null]: все элементы — ссылки на словари слоёв', async () => {
    const r = await merged(oc('A', '/OFF [41 0 R]', { ocgs: '' }), oc('B', '/OFF [41 0 R]'));
    for (const g of r.ocgs ?? []) {
      assert.ok(g instanceof Ref, `элемент /OCGs не ссылка: ${g}`);
      assert.ok((await r.doc.get(g)) instanceof Map, 'ссылка ведёт не в словарь слоя');
    }
    assert.equal(r.ocgs.length, 3, 'только слои файла B');
  });

  test('/OCProperties с битой ссылкой в /OCGs: результат читается, пустых элементов нет', async () => {
    const r = await merged(oc('A', '', { ocgs: '[40 0 R 99 0 R]' }), oc('B', ''));
    const dicts = [];
    for (const g of r.ocgs) if ((await r.doc.get(g)) instanceof Map) dicts.push(g);
    assert.equal(dicts.length, r.ocgs.length, `в /OCGs есть ссылки в пустоту: ${r.ocgs.length - dicts.length}`);
  });
});

describe('2. неверный /Count не запускает восстановление; потерянная страница — запускает', () => {
  const three = () => handPdf([{ text: 'A-P1' }, { text: 'B-P2' }, { text: 'C-P3' }]);
  const text = b => latin1(b);
  const bytes = s => new Uint8Array(Buffer.from(s, 'latin1'));

  for (const [what, edit] of [['неверный /Count 9', s => s.replace('/Count 3', '/Count 9')], ['/Count нет вовсе', s => s.replace('/Count 3', '/Xount 3')]]) {
    test(`${what} при целой таблице: rebuildXref не вызывается, три страницы`, async () => {
      const { value: doc, rebuilt } = await spyRebuild(() => PdfDoc.load(bytes(edit(text(three())))));
      assert.equal(rebuilt, 0);
      assert.deepEqual(await pageMarks(doc), ['A-P1', 'B-P2', 'C-P3']);
    });
  }

  test('ссылка на страницу ведёт на чужой объект: восстановление запускается и находит все страницы', async () => {
    const src = three();
    const bad = patchXref(src, (n, off) => (n === 5 ? offsetOf(src, 4) : off));
    const { value: doc, rebuilt } = await spyRebuild(() => PdfDoc.load(bad));
    assert.ok(rebuilt > 0);
    assert.deepEqual(await pageMarks(doc), ['A-P1', 'B-P2', 'C-P3']);
  });

  test('ссылка в пустоту (объекта нет): восстановление запускается, найденные страницы не теряются', async () => {
    const s = text(three()).replace('/Kids [3 0 R 5 0 R 7 0 R]', '/Kids [3 0 R 5 0 R 7 0 R 99 0 R]');
    const { value: doc, rebuilt } = await spyRebuild(() => PdfDoc.load(bytes(s)));
    assert.ok(rebuilt > 0, 'таблица врёт — пробуем восстановление');
    assert.equal(doc.pageRefs.length, 3);
  });
});

describe('4. именованные ссылки: лениво, по /Limits, имя ≠ строка', () => {
  const many = 5000, perLeaf = 100;
  const leaves = many / perLeaf;
  const key = i => 'n' + String(i).padStart(5, '0');
  const tree = () => {
    const objs = { 100: `<< /Kids [${Array.from({ length: leaves }, (_, i) => `${101 + i} 0 R`).join(' ')}] >>` };
    for (let l = 0; l < leaves; l++) {
      let names = '';
      for (let k = 0; k < perLeaf; k++) names += `(${key(l * perLeaf + k)}) [5 0 R /Fit] `;
      objs[101 + l] = `<< /Limits [(${key(l * perLeaf)}) (${key(l * perLeaf + perLeaf - 1)})] /Names [${names}] >>`;
    }
    return objs;
  };
  const withGet = async fn => {
    const orig = PdfDoc.prototype.get;
    const seen = new Set();
    PdfDoc.prototype.get = function (v) { if (v instanceof Ref) seen.add(v.num); return orig.call(this, v); };
    try { return { value: await fn(), seen }; } finally { PdfDoc.prototype.get = orig; }
  };

  test('без ссылок на страницах дерево /Names /Dests не читается совсем', async () => {
    const pdf = handPdf([{ text: 'A-P1' }, { text: 'A-P2' }], { catalogExtra: '/Names << /Dests 100 0 R >>', extraObjs: tree() });
    const { seen } = await withGet(() => mergePdfs([pdf]));
    const touched = [...seen].filter(n => n >= 100 && n < 100 + leaves + 1);
    assert.deepEqual(touched, [], 'дерево имён тронуто без надобности');
  });

  test('одна ссылка: по /Limits разбирается массив имён только одного нужного листа', async () => {
    const pdf = handPdf([{ text: 'A-P1', extra: '/Annots [30 0 R]' }, { text: 'A-P2' }], {
      catalogExtra: '/Names << /Dests 100 0 R >>',
      extraObjs: { ...tree(), 30: `<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /Dest (${key(2750)}) >>` },
    });
    // у кэша имён в лексере тоже есть ключ «Names», но значения не массивы — их не считаем
    const orig = Map.prototype.get;
    let leafScans = 0;
    Map.prototype.get = function (k) { if (k === 'Names' && Array.isArray(orig.call(this, 'Limits'))) leafScans++; return orig.call(this, k); };
    let r;
    try { r = await mergePdfs([pdf]); } finally { Map.prototype.get = orig; }
    assert.equal(leafScans, 1, `массивы имён просмотрены в ${leafScans} листьях`);
    const doc = await openDoc(r.blob);
    const a = await doc.get((await doc.get(doc.pageRefs[0].dict.get('Annots')))[0]);
    assert.equal(a.get('Dest')[0].num, doc.pageRefs[1].ref.num);
  });

  const two = extra => handPdf([{ text: 'A-P1', extra: '/Annots [30 0 R 31 0 R 32 0 R 33 0 R]' }, { text: 'A-P2' }, { text: 'A-P3' }], {
    catalogExtra: '/Dests << /a [5 0 R /Fit] >> /Names << /Dests 20 0 R >>',
    extraObjs: {
      20: '<< /Names [(a) [7 0 R /Fit]] >>',
      30: '<< /Type /Annot /Subtype /Link /Rect [0 0 1 1] /Dest /a >>',
      31: '<< /Type /Annot /Subtype /Link /Rect [0 2 1 3] /Dest (a) >>',
      32: '<< /Type /Annot /Subtype /Link /Rect [0 4 1 5] /A << /S /GoTo /D 60 0 R >> >>',
      33: '<< /Type /Annot /Subtype /Link /Rect [0 6 1 7] /Dest 61 0 R >>',
      60: '(a)', 61: '/a', ...extra,
    },
  });
  const dest = async (doc, i) => {
    const a = await doc.get((await doc.get(doc.pageRefs[0].dict.get('Annots')))[i]);
    let d = a.get('Dest');
    if (!d) d = (await doc.get(a.get('A'))).get('D');
    d = await doc.get(d);
    return Array.isArray(d) ? doc.pageRefs.findIndex(p => p.ref.num === d[0].num) : `не массив: ${JSON.stringify(d?.bytes ?? d?.n ?? d)}`;
  };

  test('/Dest /a (имя, каталог /Dests) и /Dest (a) (строка, дерево /Names) ведут на разные цели', async () => {
    const doc = await openDoc((await mergePdfs([two({})])).blob);
    assert.equal(await dest(doc, 0), 1, 'имя → стр. 2');
    assert.equal(await dest(doc, 1), 2, 'строка → стр. 3');
  });

  test('/D и /Dest, заданные ссылкой на строку или имя, тоже превращаются в явные', async () => {
    const doc = await openDoc((await mergePdfs([two({})])).blob);
    assert.equal(await dest(doc, 2), 2, '/A /GoTo /D 60 0 R → строка (a) → стр. 3');
    assert.equal(await dest(doc, 3), 1, '/Dest 61 0 R → имя /a → стр. 2');
  });
});

describe('5. восстановление: трейлер целиком из последнего XRef-потока', () => {
  test('в старом XRef-потоке есть /Info, в новом нет — после восстановления /Info нет', async () => {
    const base = Buffer.from(objStmPdf('ok', 'INFO-P1', { info: true }));
    assert.match(latin1(base), /\/Info 7 0 R/);
    const o11 = base.length;
    const row = Buffer.from([1, o11 >> 8, o11 & 255, 0]);
    const upd = Buffer.concat([
      Buffer.from('\n'),
      Buffer.from(`11 0 obj\n<< /Type /XRef /Size 12 /W [1 2 1] /Index [11 1] /Root 1 0 R /Length ${row.length} >>\nstream\n`),
      row, Buffer.from('\nendstream\nendobj\nstartxref\n99999999\n%%EOF\n'),
    ]);
    const doc = await PdfDoc.load(new Uint8Array(Buffer.concat([base, upd])));
    assert.deepEqual(await pageMarks(doc), ['INFO-P1']);
    assert.equal(doc.trailer.has('Info'), false, '/Info остался от старой ревизии');
    assert.equal(doc.trailer.get('Root').num, 1);
  });

  test('контроль: без обновления /Info сохраняется', async () => {
    const base = Buffer.from(objStmPdf('ok', 'INFO-P1', { info: true }));
    const broken = new Uint8Array(Buffer.from(latin1(base).replace(/startxref\n\d+/, 'startxref\n99999999'), 'latin1'));
    const doc = await PdfDoc.load(broken);
    assert.equal(doc.trailer.has('Info'), true);
  });
});
