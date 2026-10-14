import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RESUME_MPS, RESUME_MS, createFollowState } from './follow.js';

const T0 = 1_760_000_000_000;

function make() {
  const clock = { t: T0 };
  const f = createFollowState({ now: () => clock.t });
  const seen = [];
  f.subscribe((s) => seen.push(`${s.mode}${s.paused ? ':paused' : ''}`));
  return { f, clock, seen };
}

test('GEO cycles: follow, heading-up, off', () => {
  const { f, seen } = make();
  assert.equal(f.mode, 'off');
  assert.equal(f.cycle(), 'follow');
  assert.equal(f.active, true);
  assert.equal(f.cycle(), 'heading');
  assert.equal(f.cycle(), 'off');
  assert.equal(f.active, false);
  assert.deepEqual(seen, ['follow', 'heading', 'off']);
});

test('a drag pauses; GEO or RECENTER resumes in the same mode', () => {
  const { f, seen } = make();
  f.set('heading');
  f.drag();
  assert.equal(f.mode, 'heading');
  assert.equal(f.paused, true);
  assert.equal(f.active, false);
  assert.equal(f.cycle(), 'heading'); // the tap recentres, it does not step on
  assert.equal(f.paused, false);
  f.drag();
  f.resume();
  assert.equal(f.active, true);
  assert.deepEqual(seen, [
    'heading',
    'heading:paused',
    'heading',
    'heading:paused',
    'heading',
  ]);
});

test('a drag while free does nothing', () => {
  const { f, seen } = make();
  f.drag();
  f.twist();
  assert.equal(f.mode, 'off');
  assert.equal(f.paused, false);
  assert.deepEqual(seen, []);
});

test('a twist while heading-up keeps following with the user heading', () => {
  const { f } = make();
  f.set('heading');
  f.twist();
  assert.equal(f.mode, 'follow');
  assert.equal(f.active, true);
  f.twist(); // a twist in plain follow just stays
  assert.equal(f.mode, 'follow');
});

test('paused: resumes on its own when driving and untouched long enough', () => {
  const { f, clock } = make();
  f.set('follow');
  f.drag();
  clock.t += RESUME_MS - 1;
  assert.equal(f.fix(15), false); // not long enough
  clock.t += 2;
  assert.equal(f.fix(RESUME_MPS - 0.5), false); // walking pace: stays put
  assert.equal(f.fix(null), false);
  assert.equal(f.fix(15), true);
  assert.equal(f.active, true);
});

test('a touch while paused restarts the wait', () => {
  const { f, clock } = make();
  f.set('follow');
  f.drag();
  clock.t += RESUME_MS - 1000;
  f.touch();
  clock.t += 2000;
  assert.equal(f.fix(20), false);
  clock.t += RESUME_MS;
  assert.equal(f.fix(20), true);
});

test('fixes never turn following on, nor resume a follow that is not paused', () => {
  const { f, clock, seen } = make();
  clock.t += RESUME_MS * 2;
  assert.equal(f.fix(30), false);
  f.set('follow');
  assert.equal(f.fix(30), false);
  assert.deepEqual(seen, ['follow']);
});

test('set: an unknown mode is off', () => {
  const { f } = make();
  f.set('follow');
  assert.equal(f.set('sideways'), 'off');
});
