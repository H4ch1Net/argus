import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityProfileForTier } from './profile.js';

const caps = (dpr) => ({ screen: { devicePixelRatio: dpr } });

test('phones never follow devicePixelRatio and cap at 30 fps', () => {
  const p = qualityProfileForTier('balanced', caps(3.5));
  assert.equal(p.useBrowserRecommendedResolution, false);
  assert.ok(p.resolutionScale <= 1.5);
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
