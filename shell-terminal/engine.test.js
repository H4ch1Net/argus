import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTerminalLayer } from './engine.js';

// Manual timers + clock so polling and staleness are deterministic.
function fakeEnv(start = 1_000_000) {
  let t = start;
  const intervals = new Map();
  const timeouts = new Map();
  let id = 0;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    timers: {
      setInterval: (fn, ms) => (intervals.set(++id, { fn, ms }), id),
      clearInterval: (i) => intervals.delete(i),
      setTimeout: (fn) => (timeouts.set(++id, fn), id),
      clearTimeout: (i) => timeouts.delete(i),
    },
    fireIntervals() {
      for (const { fn } of intervals.values()) fn();
    },
    fireTimeouts() {
      const fns = [...timeouts.values()];
      timeouts.clear();
      for (const fn of fns) fn();
    },
    intervals,
  };
}
const flush = () => new Promise((r) => setImmediate(r));
const point = (id, lon, lat) => ({
  id,
  position: { longitude: lon, latitude: lat, altitude: 0 },
  meta: { name: id },
});

test('poll mode fetches, normalizes, and removes entities by absence', async () => {
  const env = fakeEnv();
  const batches = [[point('a', 1, 1), point('b', 2, 2)], [point('a', 1, 1)]];
  let n = 0;
  const layer = createTerminalLayer(
    {
      key: 'x',
      mode: 'poll',
      intervalMs: 1000,
      makeSource: async () => async () => batches[Math.min(n++, 1)],
      normalize: (raw) => raw,
      describe: (e) => ({ title: e.meta.name }),
      searchText: (e) => e.meta.name,
    },
    { now: env.now, timers: env.timers },
  );
  await layer.start();
  await flush();
  assert.equal(layer.size, 2);
  assert.equal(layer.status.state, 'ok');
  env.fireIntervals();
  await flush();
  assert.equal(layer.size, 1);
  assert.deepEqual(
    layer.search('a').map((h) => h.label),
    ['a'],
  );
  layer.stop();
  assert.equal(layer.size, 0);
  assert.equal(env.intervals.size, 0);
});

test('a missing source surfaces the layer reason as an error state', async () => {
  const layer = createTerminalLayer({
    key: 'fires',
    mode: 'poll',
    unavailable: 'needs FIRMS_MAP_KEY in .env (proxy side)',
    makeSource: async () => null,
    normalize: (r) => r,
  });
  await layer.start();
  await flush();
  assert.equal(layer.status.state, 'error');
  assert.match(layer.status.message, /FIRMS_MAP_KEY/);
  layer.stop();
});

test('viewport-bounded layers refetch once the view settles', async () => {
  const env = fakeEnv();
  const queries = [];
  let bbox = { lamin: 0, lamax: 1, lomin: 0, lomax: 1 };
  const layer = createTerminalLayer(
    {
      key: 'v',
      mode: 'viewport',
      makeSource: async () => async (q) => {
        queries.push(q.bbox);
        return [];
      },
      normalize: (r) => r,
    },
    { now: env.now, timers: env.timers, getQuery: () => ({ bbox }) },
  );
  await layer.start();
  await flush();
  bbox = { lamin: 5, lamax: 6, lomin: 5, lomax: 6 };
  layer.viewChanged();
  layer.viewChanged(); // debounced: only one refetch
  env.fireTimeouts();
  await flush();
  assert.deepEqual(
    queries.map((q) => q.lamin),
    [0, 5],
  );
  layer.stop();
});

test('movers interpolate one interval behind between the last two fixes', async () => {
  const env = fakeEnv(0);
  let lon = 0;
  const layer = createTerminalLayer(
    {
      key: 'm',
      mode: 'poll',
      intervalMs: 10_000,
      interpolate: true,
      makeSource: async () => async () => [point('p', lon, 0)],
      normalize: (r) => r,
    },
    { now: env.now, timers: env.timers },
  );
  await layer.start();
  await flush();
  env.advance(10_000);
  lon = 10;
  env.fireIntervals();
  await flush();
  // Halfway between the fixes (rendered one interval behind real time).
  const [e] = layer.entities(15_000);
  assert.ok(Math.abs(e.position.longitude - 5) < 1e-9);
  layer.stop();
});

test('push mode upserts as reports arrive and sweeps stale entities', async () => {
  const env = fakeEnv();
  let emit;
  const layer = createTerminalLayer(
    {
      key: 'p',
      mode: 'push',
      staleMs: 3000,
      makeSource: async () => (onBatch) => {
        emit = onBatch;
        return () => {
          emit = null;
        };
      },
      normalize: (r) => r,
    },
    { now: env.now, timers: env.timers },
  );
  await layer.start();
  emit([point('s1', 1, 1)]);
  assert.equal(layer.size, 1);
  env.advance(5000);
  env.fireIntervals(); // stale sweep
  assert.equal(layer.size, 0);
  layer.stop();
  assert.equal(emit, null, 'stop unsubscribes from the stream');
});

test('compute-position layers evaluate position from time', async () => {
  const layer = createTerminalLayer({
    key: 's',
    mode: 'once',
    positionAt: (n, t) => ({ longitude: t / 1000, latitude: 0, altitude: 400_000 }),
    makeSource: async () => async () => [point('iss', 0, 0)],
    normalize: (r) => r,
  });
  await layer.start();
  await flush();
  assert.equal(layer.entities(42_000)[0].position.longitude, 42);
  layer.stop();
});
