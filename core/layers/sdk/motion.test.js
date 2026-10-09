import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingBuffer } from './ringBuffer.js';
import {
  deadReckonInto,
  interpolateInto,
  median,
  moverPositionInto,
  smoothInto,
} from './interpolate.js';

// Smooth motion from choppy data: the helpers createLayer uses for movers.

const M_PER_DEG_LAT = 110_540;

test('dead reckoning moves along the heading at the speed, both ways', () => {
  const out = { longitude: 0, latitude: 0, altitude: 0 };
  deadReckonInto({ longitude: 10, latitude: 0, altitude: 5 }, 100, 0, 10_000, out);
  assert.ok(Math.abs((out.latitude - 0) * M_PER_DEG_LAT - 1000) < 1);
  assert.equal(out.longitude, 10);
  assert.equal(out.altitude, 5);
  deadReckonInto({ longitude: 10, latitude: 0, altitude: 0 }, 100, 90, -10_000, out);
  assert.ok(out.longitude < 10 && Math.abs(out.latitude) < 1e-9);
  // Across the antimeridian.
  deadReckonInto({ longitude: 179.999, latitude: 0, altitude: 0 }, 250, 90, 10_000, out);
  assert.ok(out.longitude < -179);
});

test('bracketing uses every retained fix, not only the last two', () => {
  const h = createRingBuffer(10);
  h.push({ t: 0, longitude: 0, latitude: 0 });
  h.push({ t: 15_000, longitude: 1.5, latitude: 0 });
  h.push({ t: 20_000, longitude: 2, latitude: 0 }); // an extra fix after a camera move
  const out = { longitude: 0, latitude: 0, altitude: 0 };
  moverPositionInto(h, 5_000, null, 0, out);
  assert.ok(Math.abs(out.longitude - 0.5) < 1e-9, 'between the first two fixes');
  // The old way (prev/curr only) jumps back to the previous fix here.
  const old = interpolateInto(h.prev(), h.last(), 5_000, { longitude: 0, latitude: 0 });
  assert.equal(old.longitude, 1.5);
});

test('past the newest fix a mover carries on, bounded; with no velocity it holds', () => {
  const h = createRingBuffer(10);
  h.push({ t: 0, longitude: 0, latitude: 0 });
  h.push({ t: 10_000, longitude: 0, latitude: 0.01 });
  const vel = { mps: 110.54, headingDeg: 0 };
  const out = { longitude: 0, latitude: 0, altitude: 0 };
  moverPositionInto(h, 12_000, vel, 5_000, out);
  assert.ok(Math.abs(out.latitude - 0.012) < 1e-6);
  moverPositionInto(h, 60_000, vel, 5_000, out);
  assert.ok(Math.abs(out.latitude - 0.015) < 1e-6, 'capped');
  moverPositionInto(h, 60_000, null, 5_000, out);
  assert.equal(out.latitude, 0.01);
  // Before the first fix it runs back, so a new contact moves at once.
  moverPositionInto(h, -3_000, vel, 5_000, out);
  assert.ok(Math.abs(out.latitude + 0.003) < 1e-6);
  const empty = createRingBuffer(2);
  assert.equal(moverPositionInto(empty, 0, vel, 1000, out), undefined);
});

test('easing glides toward the target and snaps when far or first', () => {
  const s = { longitude: 0, latitude: 0, altitude: 0, init: false };
  smoothInto(s, { longitude: 1, latitude: 1, altitude: 100 }, 16, 700);
  assert.deepEqual([s.longitude, s.latitude, s.altitude, s.init], [1, 1, 100, true]);
  smoothInto(s, { longitude: 1.0001, latitude: 1, altitude: 100 }, 700, 700);
  assert.ok(s.longitude > 1 && s.longitude < 1.0001);
  assert.ok(Math.abs(s.longitude - (1 + 0.0001 * (1 - Math.exp(-1)))) < 1e-12);
  smoothInto(s, { longitude: 2, latitude: 1, altitude: 100 }, 16, 700); // 111 km away
  assert.equal(s.longitude, 2);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

// A straight-line aircraft (220 m/s east) reported by a choppy feed: polled
// every 15 s with 0.3 to 2.5 s of fetch latency, a camera-move refetch 6 s
// after one poll, and a poll that returns the previous report again. Drawn at
// 30 fps through the same steps createLayer takes (source times aligned by the
// batch age, bracketing, dead reckoning, easing). The drawn speed must stay
// near the real one on every frame: no jumps, no stops.
test('a choppy feed draws as steady motion', () => {
  const speed = 220;
  const posAt = (tMs) => ({
    longitude: (speed * tMs) / 1000 / (111_320 * Math.cos(0)),
    latitude: 0,
    altitude: 10_000,
  });
  const reportAge = 4000; // the position is this old when a poll answers
  const polls = [];
  const latency = [300, 2500, 900, 1800, 400, 2200, 1200, 700];
  for (let k = 0; k < 8; k += 1) polls.push({ at: k * 15_000 + latency[k] });
  polls.push({ at: 3 * 15_000 + latency[3] + 6000, extra: true }); // a moveEnd refetch
  polls.sort((a, b) => a.at - b.at);
  const lagMs = 18_000;
  const h = createRingBuffer(60);
  let src = null;
  let offset = null;
  const vel = { mps: speed, headingDeg: 90 };
  const sm = { longitude: 0, latitude: 0, altitude: 0, init: false };
  const out = { longitude: 0, latitude: 0, altitude: 0 };
  let lastDrawn = null;
  const speeds = [];
  let pi = 0;
  for (let now = 0; now < 120_000; now += 1000 / 30) {
    while (pi < polls.length && polls[pi].at <= now) {
      const p = polls[pi++];
      // The 6th poll repeats the previous report (a cached answer upstream).
      const reported = pi === 6 ? src : Math.round(p.at - reportAge);
      const age = p.at - reported;
      offset = offset == null ? age : offset + (age - offset) * 0.3;
      if (src != null && reported <= src) continue; // same report: no new fix
      src = reported;
      const t = Math.max(reported + offset, (h.last()?.t ?? -Infinity) + 1);
      h.push({ t, ...posAt(reported) });
    }
    if (!h.size) continue;
    moverPositionInto(h, now - lagMs, vel, 15_000, out);
    smoothInto(sm, out, 1000 / 30, 700);
    if (lastDrawn != null && now > 25_000) {
      speeds.push((((sm.longitude - lastDrawn) * 111_320) / (1000 / 30)) * 1000);
    }
    lastDrawn = sm.longitude;
  }
  const max = Math.max(...speeds);
  const min = Math.min(...speeds);
  assert.ok(max < speed * 1.6, `fastest frame ${max.toFixed(0)} m/s`);
  assert.ok(min > speed * 0.4, `slowest frame ${min.toFixed(0)} m/s (no stops)`);

  // The old way on the same feed (ingest time, the last two fixes, one
  // interval behind) stops and jumps: the reason for all of the above.
  const old = createRingBuffer(60);
  let oldDrawn = null;
  const oldSpeeds = [];
  pi = 0;
  src = null;
  for (let now = 0; now < 120_000; now += 1000 / 30) {
    while (pi < polls.length && polls[pi].at <= now) {
      const p = polls[pi++];
      const reported = pi === 6 ? src : Math.round(p.at - reportAge);
      src = reported;
      old.push({ t: p.at, ...posAt(reported) });
    }
    if (!old.size) continue;
    interpolateInto(old.prev(), old.last(), now - 15_000, out);
    if (oldDrawn != null && now > 25_000) {
      oldSpeeds.push((((out.longitude - oldDrawn) * 111_320) / (1000 / 30)) * 1000);
    }
    oldDrawn = out.longitude;
  }
  assert.ok(Math.min(...oldSpeeds) < speed * 0.05, 'the old way stops');
  assert.ok(Math.max(...oldSpeeds) > speed * 3, 'and jumps');
});
