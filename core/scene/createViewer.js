import * as Cesium from 'cesium';
import { createBaseImageryLayer } from './imagery.js';
import { createFreeTerrain } from './terrain.js';
import { wireContextLossHandling } from './contextLoss.js';
import { createOcclusionCuller } from './occlusion.js';

// Build the Cesium Viewer for the bare globe, configured from a quality profile.
//
// This is the one place that constructs the scene. It applies the mobile
// constraints centrally so no caller has to remember them: explicit
// resolutionScale, capped targetFrameRate, requestRenderMode, and context-loss
// handling. Nothing here knows about "mobile" vs "desktop"; it consumes the
// tier-derived profile only.

/**
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {import('../capability/profile.js').qualityProfileForTier} opts.profile
 * @param {(state: { lost: boolean }) => void} [opts.onContextChange]
 * @returns {Promise<{ viewer: Cesium.Viewer, detach: () => void }>}
 */
export async function createViewer(container, { profile, onContextChange } = {}) {
  const viewer = new Cesium.Viewer(container, {
    // Free terrain baseline (flat ellipsoid) and local Natural Earth imagery.
    baseLayer: createBaseImageryLayer(),
    terrainProvider: createFreeTerrain(),

    // Render only on change. Movers will opt back into continuous render later.
    requestRenderMode: profile.requestRenderMode,
    // A long idle cap: with requestRenderMode, force at most one frame every
    // few seconds even when nothing changes (guards against a stuck scene).
    maximumRenderTimeChange: 5,

    // Strip the default widget chrome. Several of these (geocoder, baseLayer
    // picker) reach for Cesium ion by default, which we are deliberately not
    // using in Phase 1. Shells build their own UI.
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,

    // Cesium's own default; we keep failIfMajorPerformanceCaveat true so a
    // software-rendering machine fails loudly rather than running at 2fps.
    // The boot layer has already detected that case and can explain it.
    contextOptions: {
      webgl: {
        powerPreference: profile.tier === 'full' ? 'high-performance' : 'default',
      },
    },
  });

  const { scene } = viewer;

  // Quality settings from the profile. These are the mobile-first defaults.
  viewer.useBrowserRecommendedResolution = profile.useBrowserRecommendedResolution;
  viewer.resolutionScale = profile.resolutionScale;
  viewer.targetFrameRate = profile.targetFrameRate;
  scene.globe.maximumScreenSpaceError = profile.maximumScreenSpaceError;

  if (profile.msaaSamples && scene.msaaSamples !== undefined) {
    scene.msaaSamples = profile.msaaSamples;
  }

  // Keep the atmosphere/lighting cheap on constrained tiers.
  scene.fog.enabled = profile.tier !== 'minimal';
  scene.globe.showGroundAtmosphere = profile.tier !== 'minimal';
  scene.skyAtmosphere.show = true;

  // Occlusion: line features (arcs, trails) are depth-tested against the globe so
  // the portion behind the limb is hidden by the planet instead of drawing
  // through it. Point features (billboards/points/labels) opt out of depth
  // testing for crispness and are instead horizon-culled below.
  scene.globe.depthTestAgainstTerrain = true;

  // Hide the Cesium ion credit only if there is genuinely nothing to attribute;
  // Natural Earth II still carries attribution, so we leave the credit
  // container in place and just tuck it out of the way via shell CSS.

  const detachContext = wireContextLossHandling(viewer, onContextChange);

  // Horizon culling for point features, so far-side markers do not show through
  // the planet even though they ignore the depth buffer.
  const occlusion = createOcclusionCuller(viewer);

  // requestRenderMode gotcha: the first frame draws before async terrain/imagery
  // tiles arrive, and with on-change rendering nothing asks for another frame,
  // so the globe can stay blank until the user interacts. Pump a render on every
  // tile-load progress event so the globe fills in on load, then falls idle once
  // loading settles. This is the intended pairing for requestRenderMode.
  const removeProgress = scene.globe.tileLoadProgressEvent.addEventListener(() => {
    scene.requestRender();
  });
  scene.requestRender();

  const detach = () => {
    removeProgress();
    detachContext();
    occlusion.detach();
    if (!viewer.isDestroyed()) viewer.destroy();
  };

  return { viewer, detach };
}
