import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

test('OPTIONS preflight returns 204 with CORS headers', async (t) => {
  const proxy = await listen(createRequestHandler({ config: loadConfig({}), feeds: [] }));
  t.after(() => proxy.close());
  const r = await fetch(`${base(proxy)}/feed/anything`, {
    method: 'OPTIONS',
    headers: { origin: 'https://app.example' },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example');
  assert.match(r.headers.get('access-control-allow-methods'), /GET/);
});

test('health lists configured feed ids', async (t) => {
  const feeds = [{ id: 'echo', baseUrl: 'https://x/' }];
  const proxy = await listen(createRequestHandler({ config: loadConfig({}), feeds }));
  t.after(() => proxy.close());
  const r = await fetch(`${base(proxy)}/health`);
  const j = await r.json();
  assert.equal(j.status, 'ok');
  assert.equal(j.phase, 3);
  assert.deepEqual(j.feeds, [{ id: 'echo', configured: true }]);
});

test('health reports a keyed feed as unconfigured until its secret is set', async (t) => {
  const feeds = [
    { id: 'firms', baseUrl: 'https://x/', inject: [{ secret: 'FIRMS_TEST_KEY' }] },
  ];
  const saved = process.env.FIRMS_TEST_KEY;
  delete process.env.FIRMS_TEST_KEY;
  t.after(() => {
    if (saved !== undefined) process.env.FIRMS_TEST_KEY = saved;
  });
  const proxy = await listen(createRequestHandler({ config: loadConfig({}), feeds }));
  t.after(() => proxy.close());

  let j = await (await fetch(`${base(proxy)}/health`)).json();
  assert.equal(j.feeds[0].configured, false, 'unconfigured without the secret');

  process.env.FIRMS_TEST_KEY = 'present';
  j = await (await fetch(`${base(proxy)}/health`)).json();
  assert.equal(j.feeds[0].configured, true, 'configured once the secret is set');
});

test('origin allowlist blocks a non-listed origin', async (t) => {
  const config = loadConfig({ PROXY_ALLOWED_ORIGINS: 'https://allowed.example' });
  const proxy = await listen(createRequestHandler({ config, feeds: [] }));
  t.after(() => proxy.close());
  const r = await fetch(`${base(proxy)}/health`, {
    headers: { origin: 'https://evil.example' },
  });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});
