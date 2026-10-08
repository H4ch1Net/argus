import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoundRobinPositioner } from './roundRobin.js';

// A satellite moving east along the equator at 0.1 degree per second.
const linear = (calls) => (n, t) => {
  calls.push(n.id);
  return {
    longitude: ((n.lon0 + t / 10_000 + 540) % 360) - 180,
    latitude: 0,
    altitude: 5e5,
  };
};

test('each satellite is propagated once per period, spread over frames', () => {
  const calls = [];
  const pos = createRoundRobinPositioner(linear(calls), { periodMs: 1000 });
  const sats = Array.from({ length: 300 }, (_, i) => ({ id: i, lon0: 0 }));
  // First sight: everyone is propagated once.
  for (const s of sats) pos(s, 0);
  assert.equal(calls.length, 300);
  // 30 fps for 3 s: each satellite refreshes ~once a second, a few per frame.
  const perFrame = [];
  for (let f = 1; f <= 90; f++) {
    calls.length = 0;
    for (const s of sats) pos(s, (f * 1000) / 30);
    perFrame.push(calls.length);
  }
  const total = perFrame.reduce((a, b) => a + b, 0);
  assert.ok(total >= 800 && total <= 1000, `~3 refreshes each, got ${total}`);
  assert.ok(Math.max(...perFrame) <= 30, `no frame spikes, max ${Math.max(...perFrame)}`);
});

test('between refreshes the position is extrapolated, not frozen', () => {
  const calls = [];
  const pos = createRoundRobinPositioner(linear(calls), { periodMs: 5000 });
  const sat = { id: 'a', lon0: 179 };
  let t = 0;
  while (calls.length < 3) pos(sat, (t += 100));
  // After two samples, an off-sample time lands on the true track.
  const tq = t + 1234;
  const got = pos(sat, tq);
  const want = linear([])(sat, tq);
  assert.ok(
    Math.abs(got.longitude - want.longitude) < 1e-6,
    `${got.longitude} vs ${want.longitude}`,
  );
  assert.ok(got.longitude >= -180 && got.longitude <= 180);
});

test('a clock jump re-propagates at once; failures return null', () => {
  const calls = [];
  const pos = createRoundRobinPositioner(linear(calls), { periodMs: 1000 });
  const sat = { id: 'b', lon0: 0 };
  pos(sat, 0);
  pos(sat, 10);
  const before = calls.length;
  const p = pos(sat, 3_600_000); // the scrubber jumped an hour
  assert.equal(calls.length, before + 1);
  assert.ok(Math.abs(p.longitude - linear([])(sat, 3_600_000).longitude) < 1e-9);

  const dead = createRoundRobinPositioner(() => null);
  assert.equal(dead({ id: 'x' }, 0), null);
});

test('a per-satellite period (dense shell slower than core)', () => {
  const calls = [];
  const pos = createRoundRobinPositioner(linear(calls), {
    periodFor: (n) => (n.dense ? 5000 : 1000),
  });
  const core = { id: 'core', lon0: 0 };
  const dense = { id: 'dense', lon0: 0, dense: true };
  for (let t = 0; t <= 10_000; t += 50) {
    pos(core, t);
    pos(dense, t);
  }
  const n = (id) => calls.filter((c) => c === id).length;
  assert.ok(n('core') >= 10 && n('core') <= 12, `core ${n('core')}`);
  assert.ok(n('dense') >= 2 && n('dense') <= 4, `dense ${n('dense')}`);
});
