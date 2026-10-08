import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weatherSpec, WEATHER_PRODUCTS } from './products.js';

const buildUrl = (feed, path) => `https://proxy.test/feed/${feed}${path}`;

test('builds a WMS spec through the proxy feed', () => {
  const s = weatherSpec('radar', buildUrl, 0);
  assert.equal(s.kind, 'wms');
  assert.equal(s.url, 'https://proxy.test/feed/nowcoast/weather_radar/ows');
  assert.equal(s.layers, 'conus_base_reflectivity_mosaic');
  assert.equal(s.parameters.styles, 'weather_radar_base_reflectivity');
  assert.deepEqual(s.rectangle, [-127, 20, -65, 52]);
});

test('the refresh bucket changes once per interval, so tiles reload on schedule', () => {
  const ms = WEATHER_PRODUCTS.clouds.refreshMs;
  const a = weatherSpec('clouds', buildUrl, ms * 10 + 1);
  const b = weatherSpec('clouds', buildUrl, ms * 10 + ms - 1);
  const c = weatherSpec('clouds', buildUrl, ms * 11);
  assert.equal(a.parameters._, b.parameters._);
  assert.notEqual(a.parameters._, c.parameters._);
});

test('rejects an unknown product', () => {
  assert.throws(() => weatherSpec('tornado', buildUrl));
});
