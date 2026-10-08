// The Earth itself, beyond imagery and terrain: sun lighting (the real day and
// night terminator, from the scene clock), the atmosphere (sky limb, ground
// haze and fog), stars, sun and moon, relief exaggeration and how much detail
// the globe loads. Each costs little, and each is a VIEW > EARTH control.
// Detail trades sharpness for tiles: LOW halves the tile load (phones, metered
// links), HIGH sharpens terrain and imagery on a desktop GPU.

const DETAIL_SSE = { low: 4, standard: 2, high: 1.33 };

/** @param {import('cesium').Viewer} viewer */
export function createEarthController(viewer, { tier = 'balanced' } = {}) {
  const scene = viewer.scene;
  const globe = scene.globe;
  // The tier's own detail (core/capability/profile.js), what STANDARD means.
  const base = { sse: tier === 'minimal' ? 4 : 2 };
  const state = {
    lighting: false,
    atmosphere: true,
    stars: true,
    exaggeration: 1,
    detail: 'standard',
  };
  const apply = () => scene.requestRender();
  return {
    state: () => ({ ...state }),
    /** The real terminator: night side dark, lit by the sun at the scene time. */
    setLighting(on) {
      state.lighting = Boolean(on);
      if (globe) {
        globe.enableLighting = state.lighting;
        globe.dynamicAtmosphereLighting = state.lighting;
        globe.dynamicAtmosphereLightingFromSun = state.lighting;
      }
      apply();
    },
    setAtmosphere(on) {
      state.atmosphere = Boolean(on);
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = state.atmosphere;
      if (globe) globe.showGroundAtmosphere = state.atmosphere;
      if (scene.fog) scene.fog.enabled = state.atmosphere;
      apply();
    },
    setStars(on) {
      state.stars = Boolean(on);
      if (scene.skyBox) scene.skyBox.show = state.stars;
      if (scene.sun) scene.sun.show = state.stars;
      if (scene.moon) scene.moon.show = state.stars;
      apply();
    },
    /** Relief exaggeration (1 = true scale), for terrain and 3D tiles alike. */
    setExaggeration(k) {
      state.exaggeration = [1, 1.5, 2, 3].includes(k) ? k : 1;
      if ('verticalExaggeration' in scene)
        scene.verticalExaggeration = state.exaggeration;
      else if (globe) globe.terrainExaggeration = state.exaggeration;
      apply();
    },
    /** 'low' | 'standard' | 'high' globe detail (screen-space error). */
    setDetail(level) {
      state.detail = DETAIL_SSE[level] ? level : 'standard';
      // The minimal tier never goes sharper than its own budget.
      const sse =
        state.detail === 'standard'
          ? base.sse
          : tier === 'minimal'
            ? Math.max(DETAIL_SSE[state.detail], base.sse)
            : DETAIL_SSE[state.detail];
      if (globe) globe.maximumScreenSpaceError = sse;
      apply();
    },
  };
}
