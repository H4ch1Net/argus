import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalAdsb } from './parse.js';

test('parses a dump1090 / readsb aircraft.json and drops stale positions', () => {
  const out = parseLocalAdsb({
    now: 1_700_000_000.5,
    messages: 12345,
    aircraft: [
      {
        hex: 'a1b2c3',
        flight: 'N123AB  ',
        lat: 40.1,
        lon: -74.2,
        alt_baro: 3500,
        gs: 140,
        track: 90,
        seen_pos: 1.2,
        rssi: -12.3,
      },
      { hex: 'ffffff', lat: 40.2, lon: -74.3, seen_pos: 300 },
      { hex: '0a0b0c', alt_baro: 9000 }, // heard, no position
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'a1b2c3');
  assert.equal(out[0].type, 'aircraft-local');
  assert.equal(out[0].meta.callsign, 'N123AB');
  assert.equal(out[0].meta.source, 'your receiver (1090 MHz)');
  assert.deepEqual(parseLocalAdsb({}), []);
});
