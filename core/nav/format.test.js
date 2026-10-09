import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatNavDistance,
  formatNavDuration,
  formatDelay,
  formatClock,
  routeFacts,
} from './format.js';

test('distances round the way a driver reads them', () => {
  assert.equal(formatNavDistance(47), '50 M');
  assert.equal(formatNavDistance(347), '350 M');
  assert.equal(formatNavDistance(990), '1000 M');
  assert.equal(formatNavDistance(1240), '1.2 KM');
  assert.equal(formatNavDistance(23_600), '24 KM');
  assert.equal(formatNavDistance(120, 'imperial'), '400 FT');
  assert.equal(formatNavDistance(800, 'imperial'), '0.5 MI');
  assert.equal(formatNavDistance(40_000, 'imperial'), '25 MI');
  assert.equal(formatNavDistance(500, 'nautical'), '500 M');
  assert.equal(formatNavDistance(NaN), '--');
});

test('durations, delays and clock', () => {
  assert.equal(formatNavDuration(42), '42 S');
  assert.equal(formatNavDuration(720), '12 MIN');
  assert.equal(formatNavDuration(3900), '1 H 05');
  assert.equal(formatDelay(20), '');
  assert.equal(formatDelay(240), '+4 MIN');
  const d = new Date(2026, 9, 9, 7, 5);
  assert.equal(formatClock(d.getTime()), '07:05');
  assert.equal(formatClock(NaN), '--:--');
});

test('routeFacts: ETA includes the signal wait', () => {
  const now = new Date(2026, 9, 9, 9, 0).getTime();
  const f = routeFacts(
    {
      durationS: 600,
      signalDelayS: 60,
      distanceM: 5400,
      trafficDelayS: 120,
      signals: 5,
      summary: 'Folsom Street',
    },
    { now },
  );
  assert.deepEqual(f, {
    eta: '09:11',
    duration: '11 MIN',
    distance: '5.4 KM',
    delay: '+2 MIN',
    signals: '5',
    via: 'FOLSOM STREET',
  });
});
