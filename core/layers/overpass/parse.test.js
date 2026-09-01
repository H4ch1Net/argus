import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOverpass } from './parse.js';

test('parses nodes (lat/lon) and ways (center)', () => {
  const out = parseOverpass({
    elements: [
      { type: 'node', id: 1, lat: 40.1, lon: -74.0, tags: { man_made: 'surveillance' } },
      {
        type: 'way',
        id: 2,
        center: { lat: 41.2, lon: -73.5 },
        tags: { tourism: 'museum' },
      },
      { type: 'node', id: 3, tags: {} }, // no position -> dropped
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'node/1');
  assert.deepEqual(out[0].position, { longitude: -74.0, latitude: 40.1, altitude: 0 });
  assert.equal(out[1].id, 'way/2');
  assert.equal(out[1].meta.tags.tourism, 'museum');
});

test('tolerates empty input', () => {
  assert.deepEqual(parseOverpass(null), []);
  assert.deepEqual(parseOverpass({ elements: 'nope' }), []);
});
