import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestApproach, isConflict, formatTcpa, enuOffset } from './cpa.js';

test('head-on tracks meet: CPA near zero at the right time', () => {
  // 10 km apart on a north-south line, closing at 100 + 100 m/s.
  const own = { lat: 0, lon: 0, velocity: { speed: 100, heading: 0 } };
  const north = enuOffset({ lat: 0, lon: 0 }, { lat: 10_000 / 111_195, lon: 0 });
  assert.ok(Math.abs(north.n - 10_000) < 5);
  const other = { lat: 10_000 / 111_195, lon: 0, velocity: { speed: 100, heading: 180 } };
  const c = closestApproach(own, other);
  assert.equal(c.closing, true);
  assert.ok(c.cpaM < 5, `cpa ${c.cpaM}`);
  assert.ok(Math.abs(c.tcpaS - 50) < 0.5, `tcpa ${c.tcpaS}`);
  assert.equal(isConflict(c), true);
});

test('a crossing track passes at its offset; an opening one is not closing', () => {
  // Other is 5 km east, flying north; own is still: CPA is the 5 km offset now.
  const own = { lat: 0, lon: 0, velocity: { speed: 0, heading: 0 } };
  const east = { lat: -0.02, lon: 5000 / 111_195, velocity: { speed: 200, heading: 0 } };
  const c = closestApproach(own, east);
  assert.equal(c.closing, true);
  assert.ok(Math.abs(c.cpaM - 5000) < 10);
  const away = { lat: 0.02, lon: 0, velocity: { speed: 200, heading: 0 } };
  assert.equal(closestApproach(own, away).closing, false);
});

test('altitude separation and time limits filter conflicts', () => {
  const near = { closing: true, cpaM: 500, tcpaS: 60, altDiffM: 2000 };
  assert.equal(isConflict(near), false);
  assert.equal(isConflict({ ...near, altDiffM: 100 }), true);
  assert.equal(isConflict({ ...near, altDiffM: null, tcpaS: 900 }), false);
  assert.equal(formatTcpa(252), '04:12');
  assert.equal(formatTcpa(0), '--:--');
});
