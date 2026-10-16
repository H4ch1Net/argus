import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripFiller,
  nearbyKind,
  overpassNearbyQuery,
  parseNearby,
  lookupNearby,
  tileNearby,
  findNearby,
} from './nearby.js';

test('what people add when they ask out loud is dropped, names stay whole', () => {
  assert.equal(stripFiller('gas stations nearby'), 'gas stations');
  assert.equal(stripFiller('find the nearest gas station near me'), 'gas station');
  assert.equal(stripFiller('coffee near me'), 'coffee');
  assert.equal(stripFiller('show me restaurants around here'), 'restaurants');
  assert.equal(stripFiller('take me to the closest hospital'), 'hospital');
  assert.equal(stripFiller('The Home Depot'), 'The Home Depot');
  assert.equal(stripFiller('Walmart'), 'Walmart');
  assert.equal(stripFiller('46211 Jackson Street, Indio'), '46211 Jackson Street, Indio');
  // Nothing but filler: kept as it was.
  assert.equal(stripFiller('nearby'), 'nearby');
});

test('a kind of place is told from a name', () => {
  assert.equal(nearbyKind('gas')?.id, 'fuel');
  assert.equal(nearbyKind('Gas Stations Nearby')?.id, 'fuel');
  assert.equal(nearbyKind('find a gas station')?.id, 'fuel');
  assert.equal(nearbyKind('the nearest EV charger')?.id, 'charging');
  assert.equal(nearbyKind('coffee near me')?.id, 'cafe');
  assert.equal(nearbyKind('restaurants nearby')?.id, 'food');
  assert.equal(nearbyKind('parking')?.id, 'parking');
  assert.equal(nearbyKind('rest area')?.id, 'rest_area');
  assert.equal(nearbyKind('Walmart'), null);
  assert.equal(nearbyKind('Gas Lamp Quarter'), null);
  assert.equal(nearbyKind('Coffee Bean on Main'), null);
});

test('the Overpass query asks for every tag of the kind around the point', () => {
  const q = overpassNearbyQuery(nearbyKind('food'), { lat: 33.71491, lon: -116.21028 });
  assert.equal(
    q,
    '[out:json][timeout:15];(nwr["amenity"="restaurant"](around:5000,33.71491,-116.21028);' +
      'nwr["amenity"="fast_food"](around:5000,33.71491,-116.21028););out center 80;',
  );
});

test('Overpass answers become places, nearest first, named by name, brand or kind', () => {
  const near = { lat: 33.7149, lon: -116.2103 };
  const kind = nearbyKind('gas');
  const json = {
    elements: [
      {
        type: 'way',
        id: 2,
        center: { lat: 33.75, lon: -116.21 },
        tags: {
          brand: 'Chevron',
          'addr:housenumber': '45000',
          'addr:street': 'Jackson St',
          'addr:city': 'Indio',
        },
      },
      { type: 'node', id: 1, lat: 33.716, lon: -116.211, tags: { name: 'ARCO' } },
      { type: 'node', id: 3, lat: 33.72, lon: -116.22, tags: {} },
      { type: 'node', id: 1, lat: 33.716, lon: -116.211, tags: { name: 'ARCO' } },
      { type: 'node', id: 4 },
    ],
  };
  const out = parseNearby(json, kind, near);
  assert.deepEqual(
    out.map((p) => [p.name, p.detail, p.kind, p.id]),
    [
      ['ARCO', 'Gas station', 'fuel', 'osm:node/1'],
      ['Gas station', 'Gas station', 'fuel', 'osm:node/3'],
      ['Chevron', '45000 Jackson St, Indio', 'fuel', 'osm:way/2'],
    ],
  );
  assert.deepEqual(parseNearby(null, kind, near), []);
});

test('the lookup goes through the proxy overpass feed', async () => {
  const calls = [];
  const client = {
    getJson: async (feed, path, opts) => {
      calls.push([feed, path, opts.params.data]);
      return {
        elements: [
          { type: 'node', id: 9, lat: 33.72, lon: -116.21, tags: { name: 'Shell' } },
        ],
      };
    },
  };
  const out = await lookupNearby(client, nearbyKind('fuel'), { lat: 33.7, lon: -116.2 });
  assert.equal(out[0].name, 'Shell');
  assert.equal(calls[0][0], 'overpass');
  assert.equal(calls[0][1], '/interpreter');
  assert.match(calls[0][2], /amenity"="fuel/);
  assert.deepEqual(await lookupNearby(null, nearbyKind('fuel'), { lat: 1, lon: 2 }), []);
});

const HERE = { lat: 33.7149, lon: -116.2103 };
const POIS = [
  { name: 'Shell', cls: 'fuel', sub: 'fuel', lat: 33.72, lon: -116.21 },
  {
    name: 'Tesla Supercharger',
    cls: 'fuel',
    sub: 'charging_station',
    lat: 33.716,
    lon: -116.211,
  },
  { name: '', cls: 'fuel', sub: 'fuel', lat: 33.715, lon: -116.2104 },
  { name: 'Shell', cls: 'fuel', sub: 'fuel', lat: 33.72, lon: -116.21 },
  { name: 'Far Gas', cls: 'fuel', sub: 'fuel', lat: 34.5, lon: -116.2 },
  { name: 'Starbucks', cls: 'cafe', sub: 'cafe', lat: 33.714, lon: -116.21 },
];

test("the tiles' places of a kind, nearest first, within the kind's reach", () => {
  const out = tileNearby(POIS, nearbyKind('gas'), HERE);
  assert.deepEqual(
    out.map((p) => [p.name, p.kind]),
    [
      ['Gas station', 'fuel'],
      ['Shell', 'fuel'],
    ],
  );
  assert.equal(
    tileNearby(POIS, nearbyKind('ev charging'), HERE)[0].name,
    'Tesla Supercharger',
  );
});

test('tiles first, ring by ring; Overpass only when they hold too few', async () => {
  const rings = [];
  const roads = { pois: async (near, ring) => (rings.push(ring), ring >= 2 ? POIS : []) };
  let asked = 0;
  const client = { getJson: async () => (asked++, { elements: [] }) };
  const fuel = nearbyKind('fuel');
  // Two in the tiles (fewer than five): Overpass is asked, finds none, the
  // tiles' two stay.
  const out = await findNearby({ proxyClient: client, roads, kind: fuel, near: HERE });
  assert.deepEqual(rings, [1, 2, 3]);
  assert.equal(asked, 1);
  assert.equal(out.length, 2);
  // Enough in the first ring: no Overpass.
  const many = Array.from({ length: 6 }, (_, i) => ({
    ...POIS[0],
    lat: 33.72 + i * 0.001,
  }));
  asked = 0;
  const near = await findNearby({
    proxyClient: client,
    roads: { pois: async () => many },
    kind: fuel,
    near: HERE,
  });
  assert.equal(near.length, 6);
  assert.equal(asked, 0);
  // No tiles and a slow Overpass: the search does not wait past overpassMs.
  const slow = { getJson: () => new Promise(() => {}) };
  const t0 = Date.now();
  const none = await findNearby({
    proxyClient: slow,
    roads: { pois: async () => Promise.reject(new Error('down')) },
    kind: fuel,
    near: HERE,
    overpassMs: 50,
  });
  assert.deepEqual(none, []);
  assert.ok(Date.now() - t0 < 1000);
});
