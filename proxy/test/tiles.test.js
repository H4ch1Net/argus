import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { rewriteTilesetUris } from '../lib/tiles.js';

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

test('google tiles broker returns 502 with a clear message when the key is unset', async (t) => {
  const env = { ...process.env };
  delete env.GOOGLE_MAPS_API_KEY;
  // handleGoogleTiles reads process.env; scrub the key for this test.
  const saved = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  t.after(() => {
    if (saved !== undefined) process.env.GOOGLE_MAPS_API_KEY = saved;
  });

  const proxy = await listen(createRequestHandler({ config: loadConfig({}), feeds: [] }));
  t.after(() => proxy.close());

  const r = await fetch(`${base(proxy)}/tiles/google/v1/3dtiles/root.json`);
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.match(j.error, /GOOGLE_MAPS_API_KEY/);
});

test('rewriteTilesetUris keeps child URIs behind the proxy prefix', () => {
  const input = JSON.stringify({
    root: {
      content: { uri: '/v1/3dtiles/datasets/CgA/files/abc.json?session=1' },
      children: [{ content: { uri: '/v1/3dtiles/tiles/xyz.glb' } }],
    },
  });
  const out = rewriteTilesetUris(input);
  assert.ok(
    out.includes('"/tiles/google/v1/3dtiles/datasets/CgA/files/abc.json?session=1"'),
  );
  assert.ok(out.includes('"/tiles/google/v1/3dtiles/tiles/xyz.glb"'));
  // No unprefixed /v1/ paths remain.
  assert.ok(!/"\/v1\//.test(out));
});
