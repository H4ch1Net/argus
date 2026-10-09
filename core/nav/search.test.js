import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  photonPlaces,
  tomtomPlaces,
  tomtomSearchRequest,
  offlinePlaces,
  mergePlaces,
  searchDestinations,
  reverseName,
} from './search.js';

const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const PLACE_KEYS = ['detail', 'id', 'kind', 'lat', 'lon', 'name'];

test('Photon (real answer) -> Places with a name and where it is', () => {
  const places = photonPlaces(fixture('photon-ferry-building.json'));
  assert.equal(places.length, 4);
  for (const p of places) assert.deepEqual(Object.keys(p).sort(), PLACE_KEYS);
  assert.deepEqual(places[0], {
    id: 'osm:N6933256729',
    name: 'Ferry Building',
    detail: 'Harry Bridges Plaza, Financial District, San Francisco, California',
    lat: 37.7947815,
    lon: -122.393678,
    kind: 'railway=stop',
  });
  // A bare address leads with street and number.
  const [addr] = photonPlaces({
    features: [
      {
        geometry: { type: 'Point', coordinates: [2.35, 48.86] },
        properties: { street: 'Rue de Rivoli', housenumber: '10', city: 'Paris' },
      },
    ],
  });
  assert.equal(addr.name, 'Rue de Rivoli 10');
  assert.equal(addr.detail, 'Paris');
});

test('TomTom search (documented shape): request pinned, entrances preferred', () => {
  const r = tomtomSearchRequest(
    'ferry building / sf',
    { lat: 37.78123, lon: -122.41 },
    50,
  );
  assert.equal(r.feed, 'tomtom-search');
  assert.equal(r.path, '/search/ferry%20building%20%2F%20sf.json');
  assert.deepEqual(r.params, {
    limit: 10,
    typeahead: 'true',
    language: 'en-GB',
    lat: 37.781,
    lon: -122.41,
  });
  const places = tomtomPlaces(fixture('tomtom-search-documented.json'));
  assert.equal(places.length, 2, 'the broken result is skipped');
  assert.equal(places[0].name, 'Ferry Building Marketplace');
  assert.equal(places[0].detail, '1 Ferry Building, San Francisco, CA 94111');
  assert.deepEqual(
    [places[0].lat, places[0].lon],
    [37.79531, -122.39385],
    'the entrance',
  );
  assert.equal(places[0].kind, 'shop');
  assert.equal(places[1].name, 'Ferry Plaza, San Francisco, CA');
  assert.equal(places[1].kind, 'street');
});

test('merge: exact offline first, network interleaved, near duplicates dropped', () => {
  const off = offlinePlaces([
    { name: 'Paris, France', latitude: 48.86, longitude: 2.35, exact: true },
  ]).map((p) => ({ ...p, exact: true }));
  const a = [
    { id: 'a1', name: 'Paris', detail: '', lat: 48.8601, lon: 2.3501, kind: 'x' },
    {
      id: 'a2',
      name: 'Paris Gare de Lyon',
      detail: '',
      lat: 48.84,
      lon: 2.37,
      kind: 'x',
    },
  ];
  const b = [
    {
      id: 'b1',
      name: 'Paris Hilton Hotel',
      detail: '',
      lat: 48.85,
      lon: 2.29,
      kind: 'x',
    },
  ];
  const out = mergePlaces(off, [a, b], 8);
  assert.deepEqual(
    out.map((p) => p.id),
    ['place:Paris, France', 'b1', 'a2'],
  );
  assert.equal('exact' in out[0], false);
});

test('searchDestinations: offline with no proxy; one network failure does not hide the other', async () => {
  assert.deepEqual(
    (await searchDestinations(null, 'tokyo')).map((p) => p.name),
    ['Tokyo'],
  );
  const asked = [];
  const client = {
    getJson: async (feed, path, opts) => {
      asked.push([feed, path, opts.params]);
      if (feed === 'tomtom-search')
        throw Object.assign(new Error('502'), { status: 502 });
      return fixture('photon-ferry-building.json');
    },
  };
  const out = await searchDestinations(client, 'ferry building', {
    near: { lat: 37.78, lon: -122.41 },
    tomtom: true,
  });
  assert.equal(out[0].name, 'Ferry Building');
  assert.deepEqual(
    asked.map((a) => a[0]),
    ['tomtom-search', 'photon'],
  );
  assert.equal(asked[1][2].lat, 37.8);
  const down = { getJson: async () => Promise.reject(new Error('down')) };
  await assert.rejects(searchDestinations(down, 'ferry building'), /down/);
});

test('reverseName: a short name for a dropped pin, null when nothing answers', async () => {
  const client = {
    getJson: async (feed, path, { params }) => {
      assert.equal(feed, 'nominatim');
      assert.equal(path, '/reverse');
      assert.equal(params.format, 'jsonv2');
      return {
        name: '',
        display_name: '1500, Folsom Street, San Francisco',
        address: {
          house_number: '1500',
          road: 'Folsom Street',
          city: 'San Francisco',
          country: 'United States',
        },
      };
    },
  };
  assert.deepEqual(await reverseName(client, 37.77, -122.41), {
    name: '1500 Folsom Street',
    detail: 'San Francisco, United States',
  });
  assert.equal(
    await reverseName({ getJson: async () => Promise.reject(new Error('x')) }, 1, 1),
    null,
  );
  assert.equal(await reverseName(null, 1, 1), null);
});
