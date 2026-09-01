import * as Cesium from 'cesium';

// Terrain provider selection.
//
// Locked decision (master plan 9): Cesium free terrain is the default; Google
// Photorealistic 3D Tiles are an opt-in toggle, off by default on mobile /
// cellular. For Phase 1 the free baseline is a flat EllipsoidTerrainProvider:
// zero token, zero cost, always available. Quantized-mesh world terrain and
// photorealistic tiles both require a brokered ion/Google key, so they arrive
// once the proxy (Phase 2) can hold that secret server-side.

/**
 * Create the Phase 1 free terrain provider (flat ellipsoid, no elevation).
 * @returns {Cesium.TerrainProvider}
 */
export function createFreeTerrain() {
  return new Cesium.EllipsoidTerrainProvider();
}
