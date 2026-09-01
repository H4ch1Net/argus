import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNominatim } from './geocoder.js';

test('parses Nominatim results into name/lon/lat', () => {
  const out = parseNominatim([
    { display_name: 'Paris, France', lon: '2.3488', lat: '48.8534' },
    { display_name: 'Paris, Texas', lon: '-95.55', lat: '33.66' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Paris, France');
  assert.equal(out[0].longitude, 2.3488);
  assert.equal(out[0].latitude, 48.8534);
});

test('skips entries with bad coordinates or no name', () => {
  const out = parseNominatim([
    { display_name: 'Nowhere', lon: 'x', lat: '1' },
    { lon: '1', lat: '2' },
    { display_name: 'OK', lon: '10', lat: '20' },
  ]);
  assert.deepEqual(out, [{ name: 'OK', longitude: 10, latitude: 20 }]);
});

test('tolerates non-arrays', () => {
  assert.deepEqual(parseNominatim(null), []);
  assert.deepEqual(parseNominatim({}), []);
});
