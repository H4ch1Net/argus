import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThermalLadder, THERMAL_LEVELS } from './thermalLadder.js';

// Drive the ladder with a frame-time sequence at a fixed cadence. `dt` may be a
// function of the current level (a device whose frame time depends on quality).
function run(ladder, clock, ms, dt) {
  const events = [];
  let elapsed = 0;
  while (elapsed < ms) {
    const d = typeof dt === 'function' ? dt(ladder.level) : dt;
    clock.t += d;
    elapsed += d;
    const r = ladder.sample(d);
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

test('idle gaps are ignored and reset the evidence built before them', () => {
  const { clock, ladder } = setup();
  assert.deepEqual(run(ladder, clock, 120_000, 2000), []);
  // 3 s of overload, a long background pause, then normal frames: no step.
  run(ladder, clock, 3000, 70);
  run(ladder, clock, 60_000, 5000);
  assert.deepEqual(run(ladder, clock, 6000, 33), []);
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

test('recovery backs off instead of cycling on a device that reheats', () => {
  // Hot at full resolution (50 ms), fine one rung down (34 ms): a naive ladder
  // would step up and down forever.
  const { clock, ladder } = setup({ labels: ['full', 'reduced'] });
  const events = run(ladder, clock, 30 * 60_000, (level) => (level === 0 ? 50 : 34));
  assert.ok(events.length <= 8, `settled instead of cycling (${events.length} changes)`);
  assert.ok(ladder.recoverWait > 120_000, 'the recovery wait grew');
});

test('the budget follows the live frame-rate cap (cockpit mode at 60 fps)', () => {
  let fps = 30;
  const { clock, ladder } = setup({ getTargetFrameRate: () => fps });
  fps = 60;
  // 30 ms frames are fine at 30 fps but nearly double a 60 fps budget.
  const events = run(ladder, clock, 40_000, 30);
  assert.ok(events.length >= 1 && events[0].direction === 'down');
});

test('levels and labels come from the rungs the caller has', () => {
  const { clock, ladder } = setup({ labels: ['full quality', 'flat terrain'] });
  run(ladder, clock, 300_000, 80);
  assert.equal(ladder.level, 1, 'never beyond the last rung');
  assert.equal(ladder.label, 'flat terrain');
});
