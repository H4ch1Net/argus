import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTap, toleranceFor, createTapSequencer, wheelPinchFactor } from './gestures.js';

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
  assert.ok(touch.sequenceSlopPx > mouse.sequenceSlopPx);
  // A 10px wobble is a tap on touch but a drag on mouse.
  assert.equal(isTap({ dx: 10, dy: 0, dtMs: 100 }, touch), true);
  assert.equal(isTap({ dx: 10, dy: 0, dtMs: 100 }, mouse), false);
});

test('taps close in time and place count up to a triple, then start over', () => {
  const s = createTapSequencer();
  const tap = (t, x = 100, y = 100, pointerType = 'touch') =>
    s.tap({ t, x, y, pointerType });
  assert.equal(tap(0), 1);
  assert.equal(tap(180), 2);
  assert.equal(tap(350), 3);
  // The triple closed the sequence: the next quick tap is a new single.
  assert.equal(tap(450), 1);
});

test('a slow second tap is a new single tap', () => {
  const s = createTapSequencer({ maxGapMs: 300 });
  assert.equal(s.tap({ t: 0, x: 0, y: 0 }), 1);
  assert.equal(s.tap({ t: 301, x: 0, y: 0 }), 1);
  assert.equal(s.tap({ t: 500, x: 0, y: 0 }), 2);
});

test('a second tap elsewhere is a new single tap; fingers get more slop', () => {
  const s = createTapSequencer();
  assert.equal(s.tap({ t: 0, x: 0, y: 0, pointerType: 'mouse' }), 1);
  assert.equal(s.tap({ t: 100, x: 30, y: 0, pointerType: 'mouse' }), 1);
  const f = createTapSequencer();
  assert.equal(f.tap({ t: 0, x: 0, y: 0, pointerType: 'touch' }), 1);
  assert.equal(f.tap({ t: 100, x: 30, y: 0, pointerType: 'touch' }), 2);
  // Measured from the first tap of the sequence, so a drifting triple still counts.
  assert.equal(f.tap({ t: 200, x: 36, y: 10, pointerType: 'touch' }), 3);
});

test('reset forgets the sequence (a tool took the tap)', () => {
  const s = createTapSequencer();
  s.tap({ t: 0, x: 0, y: 0 });
  s.reset();
  assert.equal(s.tap({ t: 50, x: 0, y: 0 }), 1);
});

test('a trackpad pinch step zooms by the scale it reports', () => {
  assert.equal(wheelPinchFactor(0), 1);
  assert.ok(wheelPinchFactor(-10) > 1); // fingers apart: zoom in
  assert.ok(wheelPinchFactor(10) < 1);
  assert.ok(Math.abs(wheelPinchFactor(-10) * wheelPinchFactor(10) - 1) < 1e-12);
  assert.equal(wheelPinchFactor(-1000), 2);
  assert.equal(wheelPinchFactor(1000), 0.5);
  assert.equal(wheelPinchFactor(NaN), 1);
  assert.ok(wheelPinchFactor(-1, 1) > wheelPinchFactor(-1, 0)); // lines are bigger steps
});
