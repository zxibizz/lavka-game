import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server/server.js';

let server, base;
before(async () => {
  server = createServer();
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('healthz', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('serves the page, modules, models and fonts with the right types', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /view\.js/);
  for (const [p, type] of [['/game.js', /javascript/], ['/manifest.webmanifest', /manifest\+json/],
    ['/assets/props/coop.glb', /gltf-binary/], ['/vendor/nunito-cyrillic-900-normal.woff2', /font\/woff2/]]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type, p);
  }
});

test('no files outside public/, no writes', async () => {
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(base + '/nope.js')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
});
