import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThermalLadder, THERMAL_LEVELS } from './thermalLadder.js';

// Drive the ladder with a frame-time sequence at a fixed cadence.
function run(ladder, clock, ms, dt) {
  const events = [];
  for (let elapsed = 0; elapsed < ms; elapsed += dt) {
    clock.t += dt;
    const r = ladder.sample(dt);
    if (r.changed) events.push(r);
  }
  return events;
}

function setup(opts = {}) {
  const clock = { t: 0 };
  const ladder = createThermalLadder({
    targetFrameRate: 30,
    now: () => clock.t,
    ...opts,
  });
  run(ladder, clock, 5000, 33); // a cool start establishes the baseline
  return { clock, ladder };
}

test('steady frames at budget never step down', () => {
  const { clock, ladder } = setup();
  assert.deepEqual(run(ladder, clock, 120_000, 34), []);
  assert.equal(ladder.level, 0);
});

test('a sustained rise steps down one rung at a time, with a cooldown between', () => {
  const { clock, ladder } = setup();
  const events = run(ladder, clock, 60_000, 60); // throttled: ~16 fps
  assert.ok(events.length >= 2, 'stepped more than once over a minute');
  assert.ok(events.every((e) => e.direction === 'down'));
  assert.deepEqual(
    events.map((e) => e.level),
    events.map((_, i) => i + 1),
  );
  assert.equal(ladder.label, THERMAL_LEVELS[ladder.level]);
});

test('a short spike does not trigger a step', () => {
  const { clock, ladder } = setup();
  assert.deepEqual(run(ladder, clock, 3000, 80), []);
  assert.deepEqual(run(ladder, clock, 30_000, 33), []);
  assert.equal(ladder.level, 0);
});

test('idle gaps (on-demand rendering) are ignored', () => {
  const { clock, ladder } = setup();
  assert.deepEqual(run(ladder, clock, 120_000, 2000), []);
  assert.equal(ladder.level, 0);
});

test('stops at the last rung and recovers slowly once comfortable', () => {
  const { clock, ladder } = setup({ recoverMs: 60_000 });
  run(ladder, clock, 300_000, 70);
  assert.equal(ladder.level, 3);
  const up = run(ladder, clock, 70_000, 30);
  assert.equal(up.length, 1);
  assert.equal(up[0].direction, 'up');
  assert.equal(ladder.level, 2);
});
