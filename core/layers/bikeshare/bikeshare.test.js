import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIKESHARE_SYSTEMS,
  systemsInView,
  joinStations,
  createBikeshareSource,
} from './systems.js';
import {
  parseBikeshare,
  describeBikeStation,
  bikeColorHex,
  bikeshareNote,
} from './format.js';

const info = {
  data: {
    stations: [
      { station_id: 'a', name: 'W 21 St', lat: 40.74, lon: -73.99, capacity: 30 },
      {
        station_id: 'b',
        name: [{ text: 'Localized', language: 'en' }],
        lat: '40.75',
        lon: '-73.98',
      },
      { station_id: 'c', name: 'Removed', lat: 40.7, lon: -73.9 },
      { station_id: 'd', name: 'No position' },
    ],
  },
};
const status = {
  data: {
    stations: [
      {
        station_id: 'a',
        num_bikes_available: 7,
        num_docks_available: 23,
        is_renting: 1,
        is_returning: 1,
        is_installed: 1,
        last_reported: 1_700_000_000,
      },
      { station_id: 'b', num_bikes_available: 0, is_renting: true },
      { station_id: 'c', is_installed: 0 },
    ],
  },
};

test('joins information and status; GBFS 2 and 3 names; skips uninstalled', () => {
  const out = joinStations(info, status);
  assert.deepEqual(
    out.map((s) => s.id),
    ['a', 'b'],
  );
  assert.equal(out[0].bikes, 7);
  assert.equal(out[0].renting, true);
  assert.equal(out[1].name, 'Localized');
  assert.equal(out[1].lat, 40.75);
});

test('systems in view, and the source caches station information', async () => {
  const nyc = { lamin: 40.6, lamax: 40.9, lomin: -74.1, lomax: -73.8 };
  assert.deepEqual(
    systemsInView(nyc).systems.map((s) => s.id),
    ['nyc-citibike'],
  );
  assert.equal(systemsInView({ lamin: 0, lamax: 10, lomin: 0, lomax: 1 }).tooWide, true);
  const asked = [];
  const proxyClient = {
    getJson: async (feedId, path) => {
      asked.push(`${feedId}${path}`);
      return path.endsWith('information.json') ? info : status;
    },
  };
  const source = createBikeshareSource({ proxyClient });
  const r1 = await source({ bbox: nyc });
  await source({ bbox: nyc });
  assert.deepEqual(asked, [
    'gbfs-lyft/bkn/en/station_information.json',
    'gbfs-lyft/bkn/en/station_status.json',
    'gbfs-lyft/bkn/en/station_status.json',
  ]);
  const [n] = parseBikeshare(r1);
  assert.equal(n.id, 'bike:nyc-citibike:a');
  const card = describeBikeStation(n, 1_700_000_030_000);
  assert.equal(card.subtitle, 'Citi Bike (Lyft) · New York');
  assert.deepEqual(card.rows[0], ['Bikes', '7']);
  assert.deepEqual(card.rows[4], ['Reported', '30 s ago']);
  assert.equal(bikeshareNote(r1), '');
});

test('colours and registry sanity', () => {
  assert.equal(bikeColorHex({ bikes: 0, renting: true }), '#ef5350');
  assert.equal(bikeColorHex({ bikes: 2, renting: true }), '#ffb74d');
  assert.equal(bikeColorHex({ bikes: 9, renting: true }), '#66bb6a');
  for (const s of BIKESHARE_SYSTEMS) {
    assert.match(s.feedId, /^gbfs-/);
    assert.ok(Math.abs(s.center[0]) <= 90);
  }
});
