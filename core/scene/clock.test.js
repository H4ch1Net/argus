import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSceneClock } from './clock.js';

test('live by default: now tracks real time', () => {
  const c = createSceneClock();
  assert.equal(c.isLive(), true);
  assert.ok(Math.abs(c.now() - Date.now()) < 50);
});

test('setScrub freezes now at the given instant', () => {
  const c = createSceneClock();
  c.setScrub(1_000_000);
  assert.equal(c.isLive(), false);
  assert.equal(c.now(), 1_000_000);
  assert.equal(c.scrubTime(), 1_000_000);
});

test('goLive returns to real time', () => {
  const c = createSceneClock();
  c.setScrub(1_000_000);
  c.goLive();
  assert.equal(c.isLive(), true);
  assert.ok(Math.abs(c.now() - Date.now()) < 50);
});

test('subscribers fire on change, not on no-op', () => {
  const c = createSceneClock();
  let n = 0;
  const off = c.subscribe(() => (n += 1));
  c.setScrub(5000);
  c.setScrub(5000); // no change
  c.goLive();
  c.goLive(); // no change
  assert.equal(n, 2);
  off();
  c.setScrub(9000);
  assert.equal(n, 2); // unsubscribed
});

test('non-finite scrub value falls back to live', () => {
  const c = createSceneClock();
  c.setScrub(undefined);
  assert.equal(c.isLive(), true);
});
