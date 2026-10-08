import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photonParams, parsePhoton, photonLabel, extentToBbox } from './photon.js';

test('params carry only q, limit and a rounded proximity bias', () => {
  assert.deepEqual(photonParams('  Hoan Kiem  '), { q: 'Hoan Kiem', limit: 5 });
  assert.deepEqual(photonParams('x', { lat: 30.2672, lon: -97.7431 }), {
    q: 'x',
    limit: 5,
    lat: 30.3,
    lon: -97.7,
  });
  assert.deepEqual(photonParams('x', { latitude: 1, longitude: 2 }, 50), {
    q: 'x',
    limit: 10,
    lat: 1,
    lon: 2,
  });
  // A bias off the globe is dropped, not sent.
  assert.deepEqual(photonParams('x', { lat: 99, lon: 0 }), { q: 'x', limit: 5 });
  assert.equal(photonParams('a'.repeat(500)).q.length, 200);
});

test('parses Photon GeoJSON into geocoder results', () => {
  const out = parsePhoton({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [105.8524, 21.0287] },
        properties: {
          name: 'Hoan Kiem Lake',
          city: 'Hanoi',
          country: 'Vietnam',
          osm_key: 'natural',
          osm_value: 'water',
          extent: [105.85, 21.03, 105.855, 21.025],
        },
      },
      {
        geometry: { type: 'Point', coordinates: [-0.1, 51.5] },
        properties: { street: 'Downing Street', housenumber: '10', city: 'London' },
      },
      { geometry: { type: 'Point', coordinates: [500, 0] }, properties: { name: 'Bad' } },
      {
        geometry: { type: 'LineString', coordinates: [[0, 0]] },
        properties: { name: 'L' },
      },
      { geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
      null,
    ],
  });
  assert.deepEqual(out, [
    {
      name: 'Hoan Kiem Lake, Hanoi, Vietnam',
      latitude: 21.0287,
      longitude: 105.8524,
      kind: 'natural=water',
      bbox: [105.85, 21.025, 105.855, 21.03],
      source: 'photon',
    },
    {
      name: 'Downing Street 10, London',
      latitude: 51.5,
      longitude: -0.1,
      kind: null,
      bbox: null,
      source: 'photon',
    },
  ]);
  assert.deepEqual(parsePhoton(null), []);
  assert.deepEqual(parsePhoton({ features: 'x' }), []);
});

test('labels skip repeats; extents read [west, north, east, south]', () => {
  assert.equal(
    photonLabel({ name: 'Paris', city: 'Paris', country: 'France' }),
    'Paris, France',
  );
  assert.deepEqual(extentToBbox([1, 4, 3, 2]), [1, 2, 3, 4]);
  assert.equal(extentToBbox([170, 1, -170, 0]), null);
  assert.equal(extentToBbox([0, 95, 1, 0]), null);
  assert.equal(extentToBbox([0, 1]), null);
});
