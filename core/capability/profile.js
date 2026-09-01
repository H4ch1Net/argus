// Quality profile: translate a tier into concrete Cesium/scene settings.
//
// This is the single place that encodes the mobile-constraints rules from the
// master plan (6.1): set resolutionScale explicitly (do not follow
// devicePixelRatio), cap targetFrameRate, and use requestRenderMode. Higher
// tiers unlock upward. It intentionally contains only settings Phase 1 applies;
// photorealistic-terrain, post-processing, and 3D-tile-cache knobs arrive with
// the phases that use them, so this stays free of unused speculative config.

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
        // Desktops with headroom can afford native-ish resolution, capped so a
        // 4K/hiDPI panel does not quietly quadruple the pixel budget.
        resolutionScale: Math.min(dpr, 2),
        targetFrameRate: 60,
        // Screen-space error: lower is sharper terrain/tiles.
        maximumScreenSpaceError: 1.5,
        msaaSamples: 4,
      };

    case Tier.BALANCED:
      return {
        ...base,
        // ~1.0-1.5 effective; upscaling is near-invisible at arm's length on a
        // 6.9" panel. Nudge up slightly on very high-DPI screens.
        resolutionScale: dpr >= 3 ? 1.25 : 1.0,
        // 30 ambient; cockpit mode will raise this to 60 when it lands.
        targetFrameRate: 30,
        maximumScreenSpaceError: 2,
        msaaSamples: 1,
      };

    case Tier.MINIMAL:
    default:
      return {
        ...base,
        resolutionScale: 1.0,
        targetFrameRate: 30,
        maximumScreenSpaceError: 4,
        msaaSamples: 1,
      };
  }
}
