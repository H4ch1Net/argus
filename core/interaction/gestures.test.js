import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTap, toleranceFor } from './gestures.js';

test('a small, quick press is a tap', () => {
  assert.equal(isTap({ dx: 2, dy: 2, dtMs: 120 }), true);
});

test('a large move is a drag, not a tap', () => {
  assert.equal(isTap({ dx: 40, dy: 5, dtMs: 120 }), false);
});

test('a long press is not a tap', () => {
  assert.equal(isTap({ dx: 1, dy: 1, dtMs: 1500 }), false);
});

test('touch gets a larger movement threshold', () => {
  const touch = toleranceFor('touch');
  const mouse = toleranceFor('mouse');
  assert.ok(touch.moveThresholdPx > mouse.moveThresholdPx);
  assert.ok(touch.pickRadiusPx > mouse.pickRadiusPx);
  // A 10px wobble is a tap on touch but a drag on mouse.
  assert.equal(isTap({ dx: 10, dy: 0, dtMs: 100 }, touch), true);
  assert.equal(isTap({ dx: 10, dy: 0, dtMs: 100 }, mouse), false);
});
