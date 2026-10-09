import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProxyClient } from './proxyClient.js';

function fakeFetch(impl) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return impl(url, opts);
  };
  fn.calls = calls;
  return fn;
}

test('buildUrl composes feed path and params, trims base slash', () => {
  const c = createProxyClient({
    baseUrl: 'http://localhost:8787/',
    fetchImpl: async () => {},
  });
  const url = c.buildUrl('opensky', '/states/all', { lamin: 40, lomax: -73, skip: null });
  assert.equal(url, 'http://localhost:8787/feed/opensky/states/all?lamin=40&lomax=-73');
});

test('getJson returns parsed body and sets accept header', async () => {
  const fetchImpl = fakeFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ time: 1, states: [] }),
  }));
  const c = createProxyClient({ baseUrl: 'http://p', fetchImpl });
  const body = await c.getJson('opensky', '/states/all', { params: { lamin: 1 } });
  assert.deepEqual(body, { time: 1, states: [] });
  assert.equal(fetchImpl.calls[0].opts.headers.accept, 'application/json');
});

test('getJson throws with .status on non-ok', async () => {
  const fetchImpl = fakeFetch(async () => ({
    ok: false,
    status: 502,
    json: async () => ({}),
  }));
  const c = createProxyClient({ baseUrl: 'http://p', fetchImpl });
  await assert.rejects(
    () => c.getJson('opensky', '/states/all'),
    (err) => err.status === 502,
  );
});

test('requires a baseUrl', () => {
  assert.throws(() => createProxyClient({ baseUrl: '' }));
});

test('errors carry the proxy reason when it sends one', async () => {
  const client = createProxyClient({
    baseUrl: 'http://proxy.test',
    fetchImpl: async () => ({
      ok: false,
      status: 502,
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ error: 'feed firms not configured: missing FIRMS_MAP_KEY' }),
    }),
  });
  await assert.rejects(client.getText('firms', '/x'), (err) => {
    assert.equal(err.status, 502);
    assert.match(err.message, /missing FIRMS_MAP_KEY/);
    return true;
  });
});

test('onMeta hears a stale answer; tracked() adds it to every request', async () => {
  const headers = {
    'x-argus-stale': '240',
    'x-argus-cache': 'stale',
    'x-argus-upstream': 'maps.mail.ru',
  };
  const fetchImpl = fakeFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => headers[k] ?? null },
    json: async () => ({}),
    text: async () => 'x',
  }));
  const c = createProxyClient({ baseUrl: 'http://p', fetchImpl });
  const seen = [];
  await c.getJson('overpass', '/interpreter', { onMeta: (m) => seen.push(m) });
  assert.deepEqual(seen[0], {
    feedId: 'overpass',
    stale: 240,
    cache: 'stale',
    upstream: 'maps.mail.ru',
    partial: false,
  });
  const layer = [];
  const t = c.tracked((m) => layer.push(m.stale));
  await t.getText('chp-cad', '/sa.xml', { onMeta: (m) => seen.push(m.feedId) });
  assert.deepEqual(layer, [240]);
  assert.equal(seen.at(-1), 'chp-cad', "the request's own hook still runs");
  assert.equal(t.buildUrl('a', '/b'), 'http://p/feed/a/b');
  // A fresh answer, or a response without headers, is not stale.
  delete headers['x-argus-stale'];
  await t.getJson('x', '/y');
  assert.equal(layer.at(-1), null);
  const bare = createProxyClient({
    baseUrl: 'http://p',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => 1 }),
  });
  const got = [];
  assert.equal(await bare.tracked((m) => got.push(m)).getJson('x', '/y'), 1);
  assert.equal(got[0].stale, null);
  assert.equal(got[0].partial, false);
});

test('getBytes returns the body as a Uint8Array', async () => {
  const fetchImpl = fakeFetch(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array([8, 1, 18, 0]).buffer,
  }));
  const c = createProxyClient({ baseUrl: 'http://p', fetchImpl });
  const body = await c.getBytes('transit', '/x/vehicles');
  assert.ok(body instanceof Uint8Array);
  assert.deepEqual([...body], [8, 1, 18, 0]);
  assert.match(fetchImpl.calls[0].opts.headers.accept, /protobuf/);
});
