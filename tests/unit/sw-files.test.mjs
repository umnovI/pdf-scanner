// Список файлов для офлайн-режима (sw.js → FILES) полон: каждый модуль приложения и всё, что он подключает.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../helpers.mjs';

const APP = process.env.APP_DIR || path.join(ROOT, 'app');
const sw = fs.readFileSync(path.join(APP, 'sw.js'), 'utf8');
const files = [...(/const FILES = \[([\s\S]*?)\];/.exec(sw)[1]).matchAll(/'([^']+)'/g)].map(m => m[1]);

test('FILES: все .js и .css из app/ перечислены, и каждый файл из списка существует', () => {
  const onDisk = fs.readdirSync(APP).filter(f => /\.(js|css|html|webmanifest)$/.test(f) && f !== 'sw.js');
  for (const f of onDisk) assert.ok(files.includes(f) || (f === 'index.html' && files.includes('./')), `${f} не в списке офлайн-файлов`);
  for (const f of files) if (f !== './') assert.ok(fs.existsSync(path.join(APP, f)), `${f} из списка нет в app/`);
});

test('FILES: каждый модуль, подключаемый через import, есть в списке', () => {
  const seen = new Set();
  const walk = f => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = fs.readFileSync(path.join(APP, f), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([^'"]+\.js)['"]/g)) walk(m[1]);
  };
  walk('app.js');
  assert.ok(seen.has('pdfread.js') && seen.has('pdftools.js'), 'новые модули подключены');
  for (const f of seen) assert.ok(files.includes(f), `${f} подключён, но не закэшируется для работы без сети`);
});

test('FILES: без повторов', () => {
  assert.equal(new Set(files).size, files.length);
});
