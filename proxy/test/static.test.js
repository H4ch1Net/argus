import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { createStaticHandler, resolveStaticPath } from '../lib/static.js';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-static-'));
  const root = path.join(base, 'dist');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><p>argus');
  fs.writeFileSync(path.join(root, 'assets', 'main-abc.js'), 'export {};');
  fs.writeFileSync(path.join(root, 'sw.js'), 'self;');
  fs.writeFileSync(path.join(base, 'secret.env'), 'KEY=nope');
  return { base, root };
}

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('resolveStaticPath confines paths to the root', () => {
  const root = path.resolve('/srv/app');
  assert.equal(resolveStaticPath(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveStaticPath(root, '/a/b.js'), path.join(root, 'a', 'b.js'));
  // Normalization clamps traversal at the root instead of escaping it.
  assert.equal(
    resolveStaticPath(root, '/../../etc/passwd'),
    path.join(root, 'etc', 'passwd'),
  );
  assert.equal(resolveStaticPath(root, '/%2e%2e/x'), path.join(root, 'x'));
  assert.equal(resolveStaticPath(root, '/%E0%A4%A'), null); // malformed escape
  assert.equal(resolveStaticPath(root, '/a%00b'), null);
});

test('the proxy serves the built app next to its API routes', async (t) => {
  const { base, root } = fixture();
  const handler = createRequestHandler({
    config: loadConfig({}),
    feeds: [],
    serveStatic: createStaticHandler(root),
  });
  const { server, base: url } = await serve(handler);
  t.after(() => {
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const index = await fetch(`${url}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  assert.match(await index.text(), /argus/);

  const asset = await fetch(`${url}/assets/main-abc.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  await asset.arrayBuffer();

  const sw = await fetch(`${url}/sw.js`);
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  await sw.arrayBuffer();

  // API routes still win, and nothing outside the root is reachable.
  const health = await fetch(`${url}/health`);
  assert.equal((await health.json()).service, 'argus-proxy');
  const escaped = await fetch(`${url}/..%2fsecret.env`);
  assert.equal(escaped.status, 404);
  await escaped.arrayBuffer();
  const missing = await fetch(`${url}/nope.js`);
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
});

test('without a static dir the proxy answers 404 for app paths', async (t) => {
  const handler = createRequestHandler({ config: loadConfig({}), feeds: [] });
  const { server, base: url } = await serve(handler);
  t.after(() => server.close());
  const res = await fetch(`${url}/`);
  assert.equal(res.status, 404);
  await res.arrayBuffer();
});

test('lanAddresses lists external IPv4 only and tolerates a blocked interface query', async () => {
  const { lanAddresses } = await import('../lib/createServer.js');
  const list = lanAddresses({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    wlan0: [
      { family: 'IPv4', address: '192.168.1.20', internal: false },
      { family: 'IPv6', address: 'fe80::1', internal: false },
    ],
  });
  assert.deepEqual(list, ['192.168.1.20']);
  // On Android the default query throws; the call must still return an array.
  assert.ok(Array.isArray(lanAddresses()));
});
