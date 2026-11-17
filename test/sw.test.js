import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const pub = new URL('../public/', import.meta.url).pathname;
const sw = fs.readFileSync(pub + 'sw.js', 'utf8');

test('sw.js and game.js carry the same VERSION', () => {
  const v = (s) => s.match(/const VERSION = '([^']+)'/)[1];
  assert.equal(v(sw), v(fs.readFileSync(pub + 'game.js', 'utf8')));
});

test('every file the game needs offline is precached', () => {
  const listed = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(pub).map((f) => path.relative(pub, f))) {
    if (f === 'sw.js') continue;
    assert.ok(listed.has(f), `${f} is missing from ASSETS in sw.js`);
  }
  for (const f of listed) if (f !== './') assert.ok(fs.existsSync(pub + f), `${f} is listed but does not exist`);
});
