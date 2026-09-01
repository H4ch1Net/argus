import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStates } from './parse.js';

const vector = (over = {}) => {
  const s = [
    'abc123', // 0 icao24
    'DLH123 ', // 1 callsign (padded)
    'Germany', // 2 origin_country
    1_700_000_000, // 3 time_position
    1_700_000_001, // 4 last_contact
    8.5, // 5 longitude
    50.1, // 6 latitude
    11000, // 7 baro_altitude
    false, // 8 on_ground
    250, // 9 velocity
    90, // 10 true_track
    0, // 11 vertical_rate
    null, // 12 sensors
    11020, // 13 geo_altitude
    '1000', // 14 squawk
    false, // 15 spi
    0, // 16 position_source
    0, // 17 category
  ];
  return Object.assign(s, over);
};

test('parses a well-formed state vector', () => {
  const { time, aircraft } = parseStates({ time: 1_700_000_002, states: [vector()] });
  assert.equal(time, 1_700_000_002);
  assert.equal(aircraft.length, 1);
  const a = aircraft[0];
  assert.equal(a.id, 'abc123');
  assert.equal(a.callsign, 'DLH123'); // trimmed
  assert.equal(a.longitude, 8.5);
  assert.equal(a.latitude, 50.1);
  assert.equal(a.geoAltitude, 11020);
  assert.equal(a.onGround, false);
  assert.equal(a.trueTrack, 90);
});

test('drops aircraft with no position', () => {
  const noLon = vector();
  noLon[5] = null;
  const { aircraft } = parseStates({ states: [noLon, vector()] });
  assert.equal(aircraft.length, 1);
});

test('tolerates missing/empty payloads', () => {
  assert.deepEqual(parseStates(null), { time: null, aircraft: [] });
  assert.deepEqual(parseStates({}), { time: null, aircraft: [] });
  assert.deepEqual(parseStates({ states: 'nope' }), { time: null, aircraft: [] });
});
