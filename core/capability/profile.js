// Quality profile: translate a tier into concrete Cesium/scene settings.
//
// This is the single place that encodes the mobile-constraints rules from the
// master plan (6.1): set resolutionScale explicitly (do not follow
// devicePixelRatio), cap targetFrameRate, and use requestRenderMode. Higher
// tiers unlock upward. It also caps tile caches (CLAUDE.md): photoreal 3D tiles
// fill whatever memory they are given, which on a phone means the OS reclaims
// the GPU (context loss) or kills the tab.

const MiB = 1024 * 1024;

import { Tier } from './tier.js';

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
        // Render at 1:1 CSS pixels even on hiDPI panels: a 2x scale quadruples
        // the fill cost for little visible gain on a globe, and was the single
        // biggest drain on laptops with integrated graphics. (The UI itself
        // stays sharp; only the WebGL canvas is affected.)
        resolutionScale: Math.min(dpr, 1.25),
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
        // ~1.0-1.5 effective; upscaling is near-invisible at arm's length on a
        // 6.9" panel. Nudge up slightly on very high-DPI screens.
        resolutionScale: dpr >= 3 ? 1.25 : 1.0,
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
        resolutionScale: 1.0,
        targetFrameRate: 30,
        maximumScreenSpaceError: 4,
        msaaSamples: 1,
        animationFps: 15,
        tileCacheSize: 50,
        tilesetCache: { cacheBytes: 128 * MiB, maximumCacheOverflowBytes: 64 * MiB },
      };
  }
}
