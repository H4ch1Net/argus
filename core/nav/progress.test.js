import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { osrm, valhalla } from './providers.js';
import { createProgress, prepareRoute, OFF_ROUTE_M, ARRIVE_M } from './progress.js';
import { createDriveSim } from './simulate.js';
import { destination, bearingDeg } from './geo.js';
import { SIGNAL_DELAY_S } from './signals.js';

const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('prepareRoute: step starts along the line, the arrival at its end', () => {
  const [r] = osrm.parse(fixture('osrm-sf-car.json'));
  const p = prepareRoute(r);
  assert.equal(p.stepStart[0], 0);
  assert.equal(p.stepStart.at(-1), p.total);
  for (let k = 1; k < p.stepStart.length; k += 1)
    assert.ok(p.stepStart[k] >= p.stepStart[k - 1]);
  assert.ok(Math.abs(p.total - r.distanceM) < 30);
});

test('a simulated drive: steps advance, distance and time fall, then arrival', () => {
  const [r] = valhalla.parse(fixture('valhalla-mk-roundabouts.json'));
  let t = 1_000_000;
  const eng = createProgress(r, { now: () => t });
  const sim = createDriveSim(r);
  assert.ok(Math.abs(sim.durationS - r.durationS) / r.durationS < 0.1);
  const first = eng.initial();
  assert.equal(first.stepIndex, 1);
  assert.equal(first.step, r.steps[1]);
  assert.equal(first.then, r.steps[2]);
  let prev = first;
  let arrivedAt = null;
  const seen = new Set();
  for (let s = 0; s <= sim.durationS + 5; s += 1) {
    t += 1000;
    const out = eng.update(sim.fixAt(s, t));
    assert.equal(out.offRoute, false, `on the route at ${s}s`);
    const p = out.progress;
    assert.ok(p.stepIndex >= prev.stepIndex, 'steps only advance');
    assert.ok(p.distanceRemainingM <= prev.distanceRemainingM + 2);
    assert.ok(p.durationRemainingS <= prev.durationRemainingS + 2);
    assert.equal(p.eta, t + p.durationRemainingS * 1000);
    seen.add(p.stepIndex);
    prev = p;
    if (out.arrived) {
      arrivedAt = s;
      break;
    }
  }
  assert.ok(arrivedAt !== null, 'arrived');
  assert.ok(prev.distanceRemainingM < ARRIVE_M);
  assert.ok(seen.size >= r.steps.length - 3, 'every step was the next one at some point');
});

test('off route only after 3 fixes beyond 40 m; poor fixes count for neither side', () => {
  const [r] = osrm.parse(fixture('osrm-sf-car.json'));
  const eng = createProgress(r);
  const sim = createDriveSim(r);
  const on = sim.fixAt(30);
  assert.equal(eng.update(on).offRoute, false);
  // 70 m to the side of the line.
  const side = destination(on.lat, on.lon, (on.heading + 90) % 360, OFF_ROUTE_M + 30);
  const off = { ...side, accuracy: 8 };
  assert.equal(eng.update(off).offRoute, false);
  assert.equal(eng.update(off).offRoute, false);
  assert.equal(
    eng.update({ ...off, accuracy: 400 }).offRoute,
    false,
    'a poor fix is ignored',
  );
  const third = eng.update(off);
  assert.equal(third.offRoute, true);
  assert.equal(third.progress.offRoute, true);
  assert.equal(third.arrived, false);
  // Back on the line: on route again at once.
  assert.equal(eng.update(sim.fixAt(32)).offRoute, false);
});

test('signals ahead add their expected wait to the time left', () => {
  const [r] = osrm.parse(fixture('osrm-sf-car.json'));
  const eng = createProgress(r);
  const before = eng.initial();
  assert.equal(before.signalsAhead, undefined, 'unknown until counted');
  r.signalsAlongM = [100, 500, 1500];
  const p0 = eng.initial();
  assert.equal(p0.signalsAhead, 3);
  assert.equal(
    p0.durationRemainingS,
    before.durationRemainingS + 3 * SIGNAL_DELAY_S.drive,
  );
  const sim = createDriveSim(r);
  // Past the second signal.
  let p = null;
  for (let s = 0; s < 200 && (!p || p.alongM < 600); s += 1)
    p = eng.update(sim.fixAt(s)).progress;
  assert.equal(p.signalsAhead, 1);
});

test('a route that doubles back does not jump to the other carriageway', () => {
  // North 1 km, then back south 1 km, 10 m to the east.
  const line = [];
  for (let i = 0; i <= 10; i += 1) line.push([0, i * 0.0009]);
  for (let i = 10; i >= 0; i -= 1) line.push([0.00009, i * 0.0009]);
  const route = {
    geometry: line,
    mode: 'drive',
    steps: [
      { maneuver: { type: 'depart' }, distanceM: 1000, durationS: 100, geometryIndex: 0 },
      {
        maneuver: { type: 'turn', modifier: 'uturn' },
        distanceM: 1000,
        durationS: 100,
        geometryIndex: 10,
      },
      { maneuver: { type: 'arrive' }, distanceM: 0, durationS: 0, geometryIndex: 21 },
    ],
  };
  const eng = createProgress(route);
  // Driving north on the west side: progress stays on the first leg even
  // though the way back is only 10 m away.
  for (let i = 1; i <= 8; i += 1) {
    const { progress } = eng.update({ lat: i * 0.0009, lon: -0.00001 });
    assert.ok(progress.alongM < 1000, `fix ${i}: ${progress.alongM}`);
    assert.equal(progress.stepIndex, 1);
  }
  assert.ok(Math.abs(bearingDeg(0, 0, 0.0009, 0)) < 1e-9);
});
