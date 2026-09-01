import * as Cesium from 'cesium';

// Terrain provider selection and the free-vs-photorealistic toggle.
//
// Locked decision (master plan 9): a free terrain baseline is the default; Google
// Photorealistic 3D Tiles are an opt-in toggle, off by default on mobile /
// cellular. Three real modes:
//
//   flat        -> EllipsoidTerrainProvider. Zero token, zero cost, always
//                  available. The offline / metered / minimal-tier fallback.
//   terrain     -> Esri World Elevation (ArcGIS). Keyless and CORS-enabled, so the
//                  globe has genuine 3D relief with no secret. This is the default
//                  on capable, non-metered devices.
//   photoreal   -> Google Photorealistic 3D Tiles, brokered through the proxy
//                  (the Google key is server-side, never in the browser). Requires
//                  GOOGLE_MAPS_API_KEY on the proxy; without it the toggle degrades
//                  honestly rather than faking a result.

// Keyless global elevation. Real heights, CORS-enabled, no access token.
const ESRI_WORLD_ELEVATION =
  'https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer';

export const TERRAIN_SOURCES = [
  { id: 'flat', label: 'Flat' },
  { id: 'terrain', label: '3D Terrain' },
  { id: 'photoreal', label: 'Photoreal', keyed: true },
];

/** Flat ellipsoid terrain (no elevation): the always-available baseline. */
export function createFreeTerrain() {
  return new Cesium.EllipsoidTerrainProvider();
}

/** Keyless global elevation terrain (Esri World Elevation). Async. */
export function createElevationTerrain() {
  return Cesium.ArcGISTiledElevationTerrainProvider.fromUrl(ESRI_WORLD_ELEVATION);
}

/**
 * The terrain mode to start in, given the device. Real relief on capable,
 * non-metered devices; flat on metered / minimal (cellular-friendly default).
 * @param {{ tier: string, metered?: boolean }} caps
 */
export function defaultTerrainId({ tier, metered = false }) {
  return tier !== 'minimal' && !metered ? 'terrain' : 'flat';
}

/**
 * Owns the viewer's terrain and switches it between the three modes for real.
 * `set` is async and resolves to the mode actually applied, so callers (the UI)
 * can reflect a graceful fall-back (e.g. photoreal unavailable) instead of
 * showing a mode that did not take effect.
 *
 * @param {import('cesium').Viewer} viewer
 * @param {{ proxyBase?: string|null, onStatus?: (s: {id: string, ok: boolean, message?: string}) => void }} [opts]
 */
export function createTerrainController(viewer, { proxyBase = null, onStatus } = {}) {
  let current = 'flat';
  let tileset = null;

  function removePhotoreal() {
    if (tileset) {
      viewer.scene.primitives.remove(tileset); // remove(true) destroys it
      tileset = null;
    }
    viewer.scene.globe.show = true;
  }

  async function set(id) {
    if (id === current) return current;

    // Leaving photoreal always restores the globe + a heightmap terrain.
    if (current === 'photoreal') removePhotoreal();

    if (id === 'flat') {
      viewer.terrainProvider = createFreeTerrain();
      current = 'flat';
      viewer.scene.requestRender();
      onStatus?.({ id: current, ok: true });
      return current;
    }

    if (id === 'terrain') {
      try {
        viewer.terrainProvider = await createElevationTerrain();
        current = 'terrain';
        onStatus?.({ id: current, ok: true });
      } catch {
        viewer.terrainProvider = createFreeTerrain();
        current = 'flat';
        onStatus?.({
          id: 'photoreal',
          ok: false,
          message: 'elevation terrain unavailable',
        });
      }
      viewer.scene.requestRender();
      return current;
    }

    if (id === 'photoreal') {
      // The Google key lives on the proxy; the browser only ever talks to the
      // proxy. No proxy -> no key path -> say so plainly and keep the current mode.
      if (!proxyBase) {
        onStatus?.({
          id: 'photoreal',
          ok: false,
          message: 'photorealistic needs the proxy running with a Google key',
        });
        return current;
      }
      try {
        const base = proxyBase.replace(/\/+$/, '');
        tileset = await Cesium.Cesium3DTileset.fromUrl(
          `${base}/tiles/google/v1/3dtiles/root.json`,
          { showCreditsOnScreen: true },
        );
        viewer.scene.primitives.add(tileset);
        // Photoreal tiles carry their own imagery + geometry; hide the globe base
        // so it does not z-fight with the mesh.
        viewer.scene.globe.show = false;
        current = 'photoreal';
        onStatus?.({ id: current, ok: true });
      } catch {
        removePhotoreal();
        onStatus?.({
          id: 'photoreal',
          ok: false,
          message: 'photorealistic unavailable (set GOOGLE_MAPS_API_KEY on the proxy)',
        });
      }
      viewer.scene.requestRender();
      return current;
    }

    return current;
  }

  return {
    current: () => current,
    set,
    destroy: () => removePhotoreal(),
  };
}
