import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuakes } from './parse.js';

const feature = (over = {}) => ({
  id: 'us1',
  properties: {
    mag: 5.2,
    place: '10km N of Somewhere',
    time: 1_700_000_000_000,
    url: 'http://x',
  },
  geometry: { type: 'Point', coordinates: [-120.5, 38.2, 12.3] },
  ...over,
});

test('parses a feature collection', () => {
  const out = parseQuakes({ features: [feature()] });
  assert.equal(out.length, 1);
  const q = out[0];
  assert.equal(q.id, 'us1');
  assert.equal(q.type, 'earthquake');
  assert.deepEqual(q.position, { longitude: -120.5, latitude: 38.2, altitude: 0 });
  assert.equal(q.meta.mag, 5.2);
  assert.equal(q.meta.depthKm, 12.3);
  assert.equal(q.meta.place, '10km N of Somewhere');
});

test('skips features without valid coordinates', () => {
  const bad = feature({ geometry: { coordinates: [null, 1, 2] } });
  const out = parseQuakes({ features: [bad, feature()] });
  assert.equal(out.length, 1);
});

test('tolerates empty/missing input', () => {
  assert.deepEqual(parseQuakes(null), []);
  assert.deepEqual(parseQuakes({}), []);
});
