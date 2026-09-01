import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShodanFacets } from './parse.js';
import { shodanPixelSize } from './format.js';

test('maps country facets to centroid entities, skips unknown codes', () => {
  const out = parseShodanFacets({
    total: 100,
    facets: {
      country: [
        { value: 'US', count: 1_000_000 },
        { value: 'de', count: 5000 }, // lowercase -> normalized
        { value: 'ZZ', count: 9 }, // unknown -> skipped
        { value: 'JP' }, // no count -> skipped
      ],
    },
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].meta.country, 'US');
  assert.equal(out[0].type, 'shodan-density');
  assert.equal(typeof out[0].position.longitude, 'number');
  assert.equal(out[1].meta.country, 'DE');
});

test('size grows with the log of the count', () => {
  assert.ok(shodanPixelSize(1_000_000) > shodanPixelSize(100));
  assert.ok(shodanPixelSize(5_000_000) <= 42); // capped
});

test('tolerates empty input', () => {
  assert.deepEqual(parseShodanFacets(null), []);
  assert.deepEqual(parseShodanFacets({ facets: {} }), []);
});
