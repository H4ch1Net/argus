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
