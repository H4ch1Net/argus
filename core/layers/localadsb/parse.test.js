import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalAdsb, bandsLabel, uatOnly } from './parse.js';
import { createLocalReceiverSource, LOCAL_RECEIVER_FEEDS } from './source.js';
import { createLocalAdsbMockSource } from './mockSource.js';
import { formatAircraft } from '../flights/format.js';

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
  assert.deepEqual(out[0].meta.bands, ['1090']);
  assert.deepEqual(parseLocalAdsb({}), []);
  assert.deepEqual(parseLocalAdsb(null), []);
});

test('a single 978 MHz document is labelled UAT', () => {
  const [n] = parseLocalAdsb(
    {
      now: 100,
      aircraft: [{ hex: 'a00001', lat: 40, lon: -105, alt_baro: 6500, seen_pos: 0 }],
    },
    { band: '978' },
  );
  assert.equal(n.meta.source, 'your receiver (978 MHz UAT)');
  assert.equal(uatOnly(n), true);
});

const both = {
  feeds: [
    {
      band: '1090',
      payload: {
        now: 1000,
        aircraft: [
          {
            hex: 'aaaaaa',
            flight: 'ONE',
            lat: 40,
            lon: -105,
            alt_baro: 9000,
            seen: 1,
            seen_pos: 4,
          },
          {
            hex: 'bbbbbb',
            lat: 41,
            lon: -105,
            alt_baro: 31000,
            seen: 0.5,
            seen_pos: 0.5,
          },
          { hex: 'cccccc', alt_baro: 5000, seen: 2 }, // heard on 1090, no position
          { hex: '~dddddd', lat: 42, lon: -104, seen_pos: 1 }, // non-ICAO track
        ],
      },
    },
    {
      band: '978',
      payload: {
        now: 1000,
        aircraft: [
          {
            hex: 'aaaaaa',
            flight: 'ONE',
            lat: 40.01,
            lon: -105.01,
            alt_baro: 9000,
            seen: 0.2,
            seen_pos: 1,
          },
          { hex: 'cccccc', lat: 39, lon: -104, alt_baro: 5000, seen: 0.4, seen_pos: 0.4 },
          { hex: 'eeeeee', lat: 38, lon: -104, alt_baro: 4000, seen: 0.1, seen_pos: 0.1 },
          { hex: 'dddddd', lat: 43, lon: -103, seen_pos: 1 }, // the real ICAO dddddd
          { hex: 'ffffff', lat: 37, lon: -103, seen: 120, seen_pos: 120 }, // gone
        ],
      },
    },
  ],
};

test('merges both bands: newest position wins, every band that heard it is listed', () => {
  const out = parseLocalAdsb(both);
  const by = Object.fromEntries(out.map((n) => [n.id, n]));
  assert.deepEqual(Object.keys(by).sort(), [
    'aaaaaa',
    'bbbbbb',
    'cccccc',
    'dddddd',
    'eeeeee',
    '~dddddd',
  ]);
  // aaaaaa: heard on both; the 978 fix is 3 s newer, so its position is shown.
  assert.deepEqual(by.aaaaaa.meta.bands, ['1090', '978']);
  assert.equal(by.aaaaaa.meta.band, '978');
  assert.equal(by.aaaaaa.position.latitude, 40.01);
  assert.equal(by.aaaaaa.meta.source, 'your receiver (1090 MHz + 978 MHz UAT)');
  assert.equal(
    formatAircraft(by.aaaaaa.meta).rows.at(-1)[1],
    'your receiver (1090 MHz + 978 MHz UAT)',
  );
  // cccccc: positioned only by UAT, but heard on 1090 too.
  assert.deepEqual(by.cccccc.meta.bands, ['1090', '978']);
  assert.equal(by.cccccc.meta.band, '978');
  // Single-band aircraft.
  assert.deepEqual(by.bbbbbb.meta.bands, ['1090']);
  assert.equal(uatOnly(by.eeeeee), true);
  assert.equal(uatOnly(by.aaaaaa), false);
  // A non-ICAO '~' track never merges with the real ICAO address.
  assert.deepEqual(by['~dddddd'].meta.bands, ['1090']);
  assert.deepEqual(by.dddddd.meta.bands, ['978']);
});

test('band labels', () => {
  assert.equal(bandsLabel(['978', '1090']), '1090 MHz + 978 MHz UAT');
  assert.equal(bandsLabel(['978']), '978 MHz UAT');
  assert.equal(bandsLabel([]), '1090 MHz');
});

test('the receiver source polls both feeds and survives one being down', async () => {
  const asked = [];
  const proxyClient = {
    async getJson(feed, path) {
      asked.push(`${feed}${path}`);
      if (feed === 'local-uat')
        throw new Error('proxy local-uat responded 502: set LOCAL_UAT_URL');
      return { now: 1, aircraft: [] };
    },
  };
  const raw = await createLocalReceiverSource({ proxyClient })({});
  assert.deepEqual(asked, ['local-adsb/aircraft.json', 'local-uat/aircraft.json']);
  assert.deepEqual(
    raw.feeds.map((f) => f.band),
    ['1090'],
  );
  assert.deepEqual(parseLocalAdsb(raw), []);
  // Only the configured receivers, when the caller filters them.
  asked.length = 0;
  await createLocalReceiverSource({ proxyClient, feeds: [LOCAL_RECEIVER_FEEDS[0]] })({});
  assert.deepEqual(asked, ['local-adsb/aircraft.json']);
  const down = { getJson: async () => Promise.reject(new Error('offline')) };
  await assert.rejects(createLocalReceiverSource({ proxyClient: down })({}), /offline/);
});

test('the demo receivers show a two-band aircraft and UAT-only traffic', async () => {
  const raw = await createLocalAdsbMockSource()({});
  const out = parseLocalAdsb(raw);
  assert.equal(out.length, 7);
  assert.ok(out.every((n) => n.meta.source === 'demo (simulated)'));
  assert.equal(out.filter((n) => n.meta.bands.length === 2).length, 1);
  assert.equal(out.filter(uatOnly).length, 2);
});
