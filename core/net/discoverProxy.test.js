import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverProxy, isArgusHealth, feedConfigured } from './discoverProxy.js';

const HEALTH = {
  status: 'ok',
  service: 'argus-proxy',
  feeds: [
    { id: 'opensky', configured: false },
    { id: 'usgs-quakes', configured: true },
  ],
};

function fakeFetch(map) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const entry = map[url];
    if (entry instanceof Error) throw entry;
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => entry };
  };
  return { impl, calls };
}

test('uses the same origin when it answers as an Argus proxy', async () => {
  const { impl } = fakeFetch({ 'https://phone.lan:8787/health': HEALTH });
  const r = await discoverProxy({ origin: 'https://phone.lan:8787', fetchImpl: impl });
  assert.equal(r.base, 'https://phone.lan:8787');
  assert.equal(r.health.service, 'argus-proxy');
});

test('an explicit base wins and is kept even when it is down', async () => {
  const { impl, calls } = fakeFetch({
    'http://localhost:5173/health': HEALTH,
    'http://proxy.lan:8787/health': new Error('ECONNREFUSED'),
  });
  const r = await discoverProxy({
    explicit: 'http://proxy.lan:8787/',
    origin: 'http://localhost:5173',
    fetchImpl: impl,
  });
  assert.deepEqual(r, { base: 'http://proxy.lan:8787', health: null });
  assert.deepEqual(calls, ['http://proxy.lan:8787/health']);
});

test('no proxy anywhere means null (demo data in dev)', async () => {
  const { impl } = fakeFetch({});
  const r = await discoverProxy({ origin: 'http://localhost:5173', fetchImpl: impl });
  assert.deepEqual(r, { base: null, health: null });
});

test('a server that is not an Argus proxy is not mistaken for one', async () => {
  const { impl } = fakeFetch({
    'http://localhost:5173/health': {
      status: 'ok',
      service: 'something-else',
      feeds: [],
    },
  });
  const r = await discoverProxy({ origin: 'http://localhost:5173', fetchImpl: impl });
  assert.equal(r.base, null);
  assert.equal(isArgusHealth({ status: 'ok' }), false);
});

test('feedConfigured reads the health report', () => {
  assert.equal(feedConfigured(HEALTH, 'usgs-quakes'), true);
  assert.equal(feedConfigured(HEALTH, 'opensky'), false);
  assert.equal(feedConfigured(null, 'opensky'), false);
});
