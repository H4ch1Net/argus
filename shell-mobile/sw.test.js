import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Run public/sw.js in a sandbox with fake caches/fetch and check its routing:
// the app shell and static assets are cached, live data never is.

const SRC = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://argus.lan:8787';

function load({ online = true } = {}) {
  const handlers = {};
  const stores = new Map();
  const fetched = [];
  const keyOf = (r) => (typeof r === 'string' ? new URL(r, ORIGIN).href : r.url);
  const openCache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      put: async (req, res) => void m.set(keyOf(req), res),
      match: async (req) => m.get(keyOf(req)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
      delete: async (req) => m.delete(keyOf(req)),
      addAll: async (urls) => urls.forEach((u) => m.set(keyOf(u), { ok: true, body: u })),
    };
  };
  const context = {
    URL,
    console,
    Response: { error: () => ({ error: true }) },
    caches: {
      open: async (name) => openCache(name),
      keys: async () => [...stores.keys()],
      delete: async (name) => stores.delete(name),
      match: async (req) => {
        for (const m of stores.values()) if (m.has(keyOf(req))) return m.get(keyOf(req));
        return undefined;
      },
    },
    fetch: async (req) => {
      fetched.push(keyOf(req));
      if (!online) throw new Error('offline');
      return {
        ok: true,
        body: keyOf(req),
        clone() {
          return this;
        },
      };
    },
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => {
        handlers[type] = fn;
      },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
  };
  vm.createContext(context);
  vm.runInContext(SRC, context);

  async function dispatch(url, { method = 'GET', mode = 'cors' } = {}) {
    let responded = null;
    const waits = [];
    handlers.fetch({
      request: { url: new URL(url, ORIGIN).href, method, mode },
      respondWith: (p) => {
        responded = p;
      },
      waitUntil: (p) => waits.push(p),
    });
    const res = responded ? await responded : null;
    await Promise.all(waits);
    return { intercepted: Boolean(responded), res };
  }
  return { dispatch, fetched, stores, handlers };
}

test('live data, websockets, health, brokered tiles and third parties pass through', async () => {
  const sw = load();
  for (const url of [
    '/feed/usgs-quakes/all_day.geojson',
    '/ws/ais',
    '/health',
    '/tiles/google/v1/3dtiles/root.json',
    'https://services.arcgisonline.com/tile/1/2/3',
  ]) {
    assert.equal((await sw.dispatch(url)).intercepted, false, url);
  }
  assert.equal(
    (await sw.dispatch('/assets/a.js', { method: 'POST' })).intercepted,
    false,
  );
});

test('hashed assets are cache-first', async () => {
  const sw = load();
  await sw.dispatch('/assets/main-abc123.js');
  await sw.dispatch('/assets/main-abc123.js');
  assert.deepEqual(
    sw.fetched.filter((u) => u.endsWith('main-abc123.js')).length,
    1,
    'second load served from cache',
  );
});

test('Cesium statics are served stale-while-revalidate', async () => {
  const sw = load();
  const first = await sw.dispatch('/cesium/Workers/createGeometry.js');
  assert.equal(first.intercepted, true);
  const second = await sw.dispatch('/cesium/Workers/createGeometry.js');
  assert.equal(second.res.body, `${ORIGIN}/cesium/Workers/createGeometry.js`);
});

test('navigations fall back to the cached shell when offline', async () => {
  const sw = load({ online: false });
  await sw.handlers.install({ waitUntil: (p) => p });
  await new Promise((r) => setImmediate(r));
  const { intercepted, res } = await sw.dispatch('/', { mode: 'navigate' });
  assert.equal(intercepted, true);
  assert.equal(res.body, '/');
});

test('caches are versioned per build and old builds are dropped on activate', async () => {
  assert.match(SRC, /__ARGUS_BUILD__/, 'the build stamp placeholder is present');
  const sw = load();
  await sw.dispatch('/assets/x.js');
  // A previous build's cache, as an older service worker would have left it.
  await sw.stores.set('argus-static-oldbuild', new Map());
  await sw.handlers.activate({ waitUntil: (p) => p });
  await new Promise((r) => setImmediate(r));
  assert.equal(sw.stores.has('argus-static-oldbuild'), false);
  assert.equal(sw.stores.has('argus-static-__ARGUS_BUILD__'), true);
});
