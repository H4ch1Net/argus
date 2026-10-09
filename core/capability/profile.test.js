import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityProfileForTier, resolutionScaleFor } from './profile.js';

const caps = (dpr) => ({ screen: { devicePixelRatio: dpr } });

test('phones never follow devicePixelRatio and cap at 30 fps', () => {
  const p = qualityProfileForTier('balanced', caps(3.5));
  assert.equal(p.useBrowserRecommendedResolution, false);
  // Cesium renders at devicePixelRatio x resolutionScale: at most 2 per CSS px.
  assert.ok(3.5 * p.resolutionScale <= 2 + 1e-9);
  assert.ok(3.5 * p.resolutionScale >= 1.5);
  assert.equal(p.targetFrameRate, 30);
  assert.equal(p.requestRenderMode, true);
});

test('tile caches are capped, smallest on the weakest tier', () => {
  const [min, bal, full] = ['minimal', 'balanced', 'full'].map((t) =>
    qualityProfileForTier(t, caps(2)),
  );
  assert.ok(
    min.tileCacheSize < bal.tileCacheSize && bal.tileCacheSize < full.tileCacheSize,
  );
  assert.ok(min.tilesetCache.cacheBytes < bal.tilesetCache.cacheBytes);
  assert.ok(bal.tilesetCache.cacheBytes <= 256 * 1024 * 1024);
  assert.ok(full.tilesetCache.maximumCacheOverflowBytes > 0);
});

test('resolution is rendered pixels per CSS pixel, never above the panel', () => {
  assert.equal(resolutionScaleFor(2, 3.5), 2 / 3.5);
  assert.equal(resolutionScaleFor(2, 1), 1, 'a 1x screen renders at 1x');
  assert.equal(resolutionScaleFor('native', 3.5), 1);
  assert.equal(resolutionScaleFor(1.5, 2), 0.75);
  for (const tier of ['minimal', 'balanced', 'full']) {
    for (const dpr of [1, 2, 3.5]) {
      const p = qualityProfileForTier(tier, caps(dpr));
      assert.ok(dpr * p.resolutionScale <= 2 + 1e-9, `${tier} at ${dpr}`);
      assert.ok(p.resolutionScale <= 1);
    }
  }
});
