import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceToCamera } from './orientation.js';

test('iOS webkitCompassHeading is used directly for heading', () => {
  const o = deviceToCamera({ webkitCompassHeading: 90, beta: 90 });
  assert.equal(o.heading, 90);
  assert.equal(o.pitch, 0); // vertical phone -> horizon
});

test('alpha (counter-clockwise) converts to a clockwise compass heading', () => {
  // alpha 90 CCW -> compass 270.
  const o = deviceToCamera({ alpha: 90, beta: 90 });
  assert.equal(o.heading, 270);
});

test('beta maps to pitch: vertical=horizon, tilted back=up, clamped', () => {
  assert.equal(deviceToCamera({ beta: 90 }).pitch, 0);
  assert.equal(deviceToCamera({ beta: 150 }).pitch, 60);
  assert.equal(deviceToCamera({ beta: 300 }).pitch, 90); // clamped to zenith
  assert.equal(deviceToCamera({ beta: -90 }).pitch, -90); // clamped downward
});

test('screen rotation offsets the heading and stays in [0,360)', () => {
  const o = deviceToCamera({ webkitCompassHeading: 350, beta: 90 }, 90);
  assert.equal(o.heading, 80); // (350 + 90) % 360
});
