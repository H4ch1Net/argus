// Quality profile: translate a tier into concrete Cesium/scene settings.
//
// This is the single place that encodes the mobile-constraints rules from the
// master plan (6.1): set resolutionScale explicitly (do not follow
// devicePixelRatio), cap targetFrameRate, and use requestRenderMode. Higher
// tiers unlock upward.
//
// Resolution is stated as rendered pixels per CSS pixel. With
// useBrowserRecommendedResolution off, Cesium renders at devicePixelRatio x
// resolutionScale, so the scale is that target over the device's ratio
// (resolutionScaleFor). A QHD+ phone reports about 3.5: a scale of 1.25 there
// meant 4.4 rendered pixels per CSS pixel, more than the panel itself. It also caps tile caches (CLAUDE.md): photoreal 3D tiles
// fill whatever memory they are given, which on a phone means the OS reclaims
// the GPU (context loss) or kills the tab.

const MiB = 1024 * 1024;

import { Tier } from './tier.js';

/**
 * Cesium's resolutionScale for a target of rendered pixels per CSS pixel
 * (never above the panel's own density). 'native' renders at the panel's.
 */
export function resolutionScaleFor(pixelsPerPoint, dpr) {
  const d = dpr > 0 ? dpr : 1;
  if (pixelsPerPoint === 'native') return 1;
  return Math.min(Math.max(0.5, Number(pixelsPerPoint) || 1), d) / d;
}

/**
 * @param {string} tier - one of Tier.*
 * @param {ReturnType<import('./detect.js').detectCapabilities>} caps
 */
export function qualityProfileForTier(tier, caps) {
  const dpr = caps.screen.devicePixelRatio || 1;

  const base = {
    tier,
    // Render only on change. Near-zero cost with static layers and a still
    // camera; movers (added later) will drive continuous render themselves.
    requestRenderMode: true,
    // Never follow devicePixelRatio blindly (~3.5-4 at QHD+ throttles fast).
    useBrowserRecommendedResolution: false,
  };

  switch (tier) {
    case Tier.FULL:
      return {
        ...base,
        // Up to 2 rendered pixels per CSS pixel: sharp glyphs and map tiles
        // (drawn at 2x) on hiDPI laptops, without the fill cost of a 3x panel.
        pixelsPerPoint: Math.min(dpr, 2),
        resolutionScale: resolutionScaleFor(Math.min(dpr, 2), dpr),
        targetFrameRate: 60,
        // Screen-space error: lower is sharper terrain/tiles.
        maximumScreenSpaceError: 2,
        // FXAA (Cesium's default) is enough for hairline glyphs; 4x MSAA cost
        // too much on integrated GPUs.
        msaaSamples: 1,
        // Movers request frames at this rate; cockpit and camera moves go higher.
        animationFps: 30,
        // Globe terrain/imagery tiles kept in memory, and the photoreal tileset's
        // byte budget (cacheBytes + how far it may overflow while loading).
        tileCacheSize: 300,
        tilesetCache: { cacheBytes: 512 * MiB, maximumCacheOverflowBytes: 512 * MiB },
      };

    case Tier.BALANCED:
      return {
        ...base,
        // 2 rendered pixels per CSS pixel at most: the map tiles are drawn at
        // 2x, so a 3.5x QHD+ panel gains little above it, and it is a third of
        // the fill of rendering at the panel's full density (the thermal
        // budget). SETUP > resolution can go to native.
        pixelsPerPoint: Math.min(dpr, 2),
        resolutionScale: resolutionScaleFor(Math.min(dpr, 2), dpr),
        // 30 ambient; cockpit mode raises this to 60.
        targetFrameRate: 30,
        maximumScreenSpaceError: 2,
        msaaSamples: 1,
        animationFps: 20,
        tileCacheSize: 100,
        tilesetCache: { cacheBytes: 256 * MiB, maximumCacheOverflowBytes: 128 * MiB },
      };

    case Tier.MINIMAL:
    default:
      return {
        ...base,
        pixelsPerPoint: Math.min(dpr, 1.5),
        resolutionScale: resolutionScaleFor(Math.min(dpr, 1.5), dpr),
        targetFrameRate: 30,
        maximumScreenSpaceError: 4,
        msaaSamples: 1,
        animationFps: 15,
        tileCacheSize: 50,
        tilesetCache: { cacheBytes: 128 * MiB, maximumCacheOverflowBytes: 64 * MiB },
      };
  }
}
