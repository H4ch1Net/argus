import * as Cesium from 'cesium';
import { vectorProvider } from './imagery.js';

// Map label overlays: place names and borders, and roads with street names,
// drawn above the basemap and every raster overlay. With the proxy they are
// the ctOS vector labels (core/scene/vector/render.js: white monospace on a
// dark keyline, over any basemap, sharp at any zoom); without it, keyless Esri
// reference tiles toned to ctOS grays (their road labels are yellow as served).
// Offline city names (no network at all) are drawn by the tracking overlay
// from the bundled list instead; see core/scene/trackingOverlay.js.

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';
// Esri labels in ctOS grays: no colour, lifted so the yellow road names and
// the gray place names both read as white-ish text.
const ESRI_LABEL_TONE = { saturation: 0, brightness: 1.5, contrast: 1.1, gamma: 1 };

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
      const vector = on[kind] && vectorProvider(kind) ? `vector:${kind}` : null;
      const want = on[kind] ? (vector ?? SERVICES[kind](basemap)) : null;
      const have = active.get(kind);
      if (have && have.url !== want) {
        if (layers.contains(have.layer)) layers.remove(have.layer, true);
        active.delete(kind);
      }
      if (want && !active.has(kind)) {
        const layer = vector
          ? new Cesium.ImageryLayer(vectorProvider(kind), {})
          : Cesium.ImageryLayer.fromProviderAsync(
              Cesium.ArcGisMapServerImageryProvider.fromUrl(want, {
                enablePickFeatures: false,
              }),
              {},
            );
        if (!vector) Object.assign(layer, ESRI_LABEL_TONE);
        layers.add(layer);
        active.set(kind, { layer, url: want });
      }
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
    /** Rebuild the overlays (the vector basemap came or went). */
    refresh() {
      for (const [kind, a] of active) {
        if (layers.contains(a.layer)) layers.remove(a.layer, true);
        active.delete(kind);
      }
      sync();
    },
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
