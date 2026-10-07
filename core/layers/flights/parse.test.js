import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStates,
  parseAdsb,
  parseFlights,
  bboxToPointQuery,
  adsbPointPath,
  ADSB_MAX_RADIUS_NM,
} from './parse.js';

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

test('OpenSky aircraft are labelled with their source; demo payloads say demo', () => {
  assert.equal(parseStates({ states: [vector()] }).aircraft[0].source, 'OpenSky');
  assert.equal(
    parseStates({ states: [vector()], demo: true }).aircraft[0].source,
    'demo (simulated)',
  );
});

const adsbAc = (over = {}) => ({
  hex: 'A1B2C3',
  flight: 'UAL123  ',
  r: 'N12345',
  t: 'B738',
  alt_baro: 35000,
  alt_geom: 35500,
  gs: 450,
  track: 270.5,
  baro_rate: -640,
  squawk: '1200',
  lat: 37.6,
  lon: -122.4,
  ...over,
});

test('parseAdsb converts readsb units to the SI aircraft shape', () => {
  const { time, aircraft } = parseAdsb({ ac: [adsbAc()], now: 1_700_000_000_500 });
  assert.equal(time, 1_700_000_001);
  const a = aircraft[0];
  assert.equal(a.id, 'a1b2c3');
  assert.equal(a.callsign, 'UAL123');
  assert.equal(a.registration, 'N12345');
  assert.equal(a.typeCode, 'B738');
  assert.equal(a.onGround, false);
  assert.ok(Math.abs(a.baroAltitude - 10668) < 1); // 35000 ft
  assert.ok(Math.abs(a.geoAltitude - 10820.4) < 1);
  assert.ok(Math.abs(a.velocity - 231.5) < 0.5); // 450 kt
  assert.ok(Math.abs(a.verticalRate - -3.25) < 0.01); // -640 ft/min
  assert.equal(a.trueTrack, 270.5);
  assert.equal(a.source, 'adsb.lol');
});

test('parseAdsb handles ground, TIS-B ids, and drops positionless aircraft', () => {
  const { aircraft } = parseAdsb({
    ac: [
      adsbAc({ hex: '~abc', alt_baro: 'ground', alt_geom: undefined }),
      adsbAc({ lat: undefined }),
      null,
      { lat: 1, lon: 2 }, // no hex
    ],
  });
  assert.equal(aircraft.length, 1);
  assert.equal(aircraft[0].id, 'abc');
  assert.equal(aircraft[0].onGround, true);
  assert.equal(aircraft[0].baroAltitude, 0);
  assert.equal(aircraft[0].geoAltitude, null);
  assert.deepEqual(parseAdsb(null), { time: null, aircraft: [] });
});

test('parseFlights detects the payload format', () => {
  assert.equal(parseFlights({ ac: [adsbAc()] }).aircraft[0].source, 'adsb.lol');
  assert.equal(parseFlights({ states: [vector()] }).aircraft[0].source, 'OpenSky');
  assert.deepEqual(parseFlights(undefined), { time: null, aircraft: [] });
});

test('bboxToPointQuery centres on the view and caps the radius', () => {
  const small = bboxToPointQuery({ lamin: 37, lamax: 38, lomin: -123, lomax: -122 });
  assert.equal(small.latitude, 37.5);
  assert.equal(small.longitude, -122.5);
  assert.ok(small.radiusNm > 30 && small.radiusNm < 45);
  const world = bboxToPointQuery({ lamin: -90, lamax: 90, lomin: -180, lomax: 180 });
  assert.equal(world.radiusNm, ADSB_MAX_RADIUS_NM);
  const tiny = bboxToPointQuery({ lamin: 1, lamax: 1.001, lomin: 1, lomax: 1.001 });
  assert.equal(tiny.radiusNm, 5);
  assert.equal(
    adsbPointPath({ lamin: 37, lamax: 38, lomin: -123, lomax: -122 }),
    `/v2/point/37.5/-122.5/${small.radiusNm}`,
  );
});
