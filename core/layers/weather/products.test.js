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

test('lightning density uses the lightning service', () => {
  const s = weatherSpec('lightning', buildUrl, 0);
  assert.equal(s.url, 'https://proxy.test/feed/nowcoast/lightning_detection/ows');
  assert.equal(s.layers, 'ldn_lightning_strike_density');
});

test('a time pins the frame instead of the refresh bucket', () => {
  const s = weatherSpec('radar', buildUrl, 0, { time: '2026-10-08T12:00:00Z' });
  assert.equal(s.parameters.time, '2026-10-08T12:00:00.000Z');
  assert.equal(s.parameters._, undefined);
  assert.equal(s.time, '2026-10-08T12:00:00.000Z');
  // A bare string works too, and a phone can cap the detail level.
  const t = weatherSpec('radar', buildUrl, 0, '2026-10-08T12:00:00Z');
  assert.equal(t.parameters.time, s.parameters.time);
  assert.equal(weatherSpec('radar', buildUrl, 0, { maximumLevel: 5 }).maximumLevel, 5);
  assert.throws(() => weatherSpec('radar', buildUrl, 0, { time: '2026-10-08/PT1H' }));
  assert.throws(() => weatherSpec('radar', buildUrl, 0, { time: 'now' }));
});

test('GOES regional infrared is a satellite-service product', () => {
  const s = weatherSpec('goes', buildUrl, 0);
  assert.equal(s.url, 'https://proxy.test/feed/nowcoast/satellite/ows');
  assert.equal(s.layers, 'goes_longwave_imagery');
  assert.equal(s.parameters.styles, 'goes-lir');
  for (const p of Object.values(WEATHER_PRODUCTS)) {
    assert.ok(p.maxGapMs > 0 && p.metadataTtlMs > 0);
  }
});
