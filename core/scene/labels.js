import * as Cesium from 'cesium';
import { applyTone } from './imagery.js';

// Map label overlays: place names and borders, and roads with street names, as
// keyless Esri reference tile layers drawn above the basemap and every raster
// overlay. Place labels follow the basemap: the dark canvas has its own
// light-on-dark reference layer, imagery and streets use Boundaries and Places.
// Offline city names (no network at all) are drawn by the tracking overlay
// from the bundled list instead; see core/scene/trackingOverlay.js.

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';
const SERVICES = {
  places: (basemap) =>
    basemap === 'dark'
      ? `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer`
      : `${ESRI}/Reference/World_Boundaries_and_Places/MapServer`,
  roads: () => `${ESRI}/Reference/World_Transportation/MapServer`,
};

export const LABEL_KINDS = [
  { id: 'places', label: 'Places + borders', title: 'Country, region and city names' },
  { id: 'roads', label: 'Roads + streets', title: 'Road network with street names' },
];

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ imagery: { current: () => string, mono: () => boolean, subscribe: Function } }} deps
 */
export function createLabelsController(viewer, { imagery }) {
  const layers = viewer.imageryLayers;
  const on = { places: false, roads: false };
  const active = new Map(); // kind -> { layer, url }

  function raise() {
    for (const kind of ['roads', 'places']) {
      const a = active.get(kind);
      if (a && layers.contains(a.layer)) layers.raiseToTop(a.layer);
    }
  }

  function sync() {
    const basemap = imagery.current();
    for (const kind of Object.keys(on)) {
      const want = on[kind] ? SERVICES[kind](basemap) : null;
      const have = active.get(kind);
      if (have && have.url !== want) {
        if (layers.contains(have.layer)) layers.remove(have.layer, true);
        active.delete(kind);
      }
      if (want && !active.has(kind)) {
        const layer = Cesium.ImageryLayer.fromProviderAsync(
          Cesium.ArcGisMapServerImageryProvider.fromUrl(want, {
            enablePickFeatures: false,
          }),
          {},
        );
        layers.add(layer);
        active.set(kind, { layer, url: want });
      }
      const a = active.get(kind);
      // Over the dark canvas the reference labels are already gray.
      if (a) applyTone(a.layer, imagery.mono() && basemap !== 'dark');
    }
    raise();
    viewer.scene.requestRender();
  }

  // Keep labels above weather rasters added later.
  const removeAdded = layers.layerAdded.addEventListener((layer) => {
    if ([...active.values()].some((a) => a.layer === layer)) return;
    raise();
  });
  const unsubscribe = imagery.subscribe(sync);

  return {
    get: (kind) => Boolean(on[kind]),
    set(kind, value) {
      if (!(kind in on)) return;
      on[kind] = Boolean(value);
      sync();
    },
    destroy() {
      removeAdded();
      unsubscribe();
      for (const kind of Object.keys(on)) on[kind] = false;
      sync();
    },
  };
}
