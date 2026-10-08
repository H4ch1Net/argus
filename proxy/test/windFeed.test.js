import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeds } from '../feeds.js';
import { windGrid, windQuery } from '../../core/layers/wind/field.js';

const feed = feeds.find((f) => f.id === 'openmeteo-wind');
const allow = (params) => feed.allowQuery(new URLSearchParams(params));

test('the wind feed accepts exactly what core asks for', () => {
  assert.ok(feed, 'registered');
  const q = windQuery(windGrid({ lamin: 40, lomin: -10, lamax: 55, lomax: 10 }));
  assert.equal(allow(q), true);
  assert.ok(feed.allowPaths.some((r) => r.test('/v1/forecast')));
});

test('anything else is refused', () => {
  const q = windQuery(windGrid({ lamin: 40, lomin: -10, lamax: 55, lomax: 10 }));
  assert.equal(allow({ ...q, hourly: 'temperature_2m' }), false, 'extra parameter');
  assert.equal(allow({ ...q, current: 'temperature_2m' }), false, 'other fields');
  assert.equal(allow({ ...q, longitude: '1,2' }), false, 'mismatched counts');
  assert.equal(allow({ ...q, latitude: q.latitude.replace(/^[^,]+/, '95') }), false);
  const many = Array.from({ length: 65 }, () => '1').join(',');
  assert.equal(
    allow({ ...q, latitude: many, longitude: many }),
    false,
    'too many points',
  );
  assert.equal(
    allow({ ...q, latitude: '1.234,2', longitude: '1,2' }),
    false,
    'precision',
  );
});
