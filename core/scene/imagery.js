import * as Cesium from 'cesium';

// Base imagery + imagery switching.
//
// The default is the Natural Earth II tiles that ship inside the Cesium package
// (Assets/Textures/NaturalEarthII): no token, no network, offline, no secrets, so
// the globe always starts. It is a coarse whole-world basemap with NO street-level
// detail, so two higher-resolution sources sit on top of it as an explicit choice:
//
//   dark      -> Esri World Dark Gray Canvas (base only, no labels): the ctOS look,
//                quiet land and sea so contacts read first. Keyless.
//   satellite -> Esri World Imagery (ArcGIS), aerial photography, the Google-Earth
//                look. Keyless public tile service.
//   streets   -> OpenStreetMap, roads + labels, so you can see which street a
//                surveillance camera / ALPR reader actually sits on.
//
// These load their tiles directly (both HTTPS + CORS-enabled, so no mixed-content
// block on mobile); proxy-side tile caching is a possible later optimization. They
// are off by default (cellular-friendly, per the mobile constraints), matching the
// locked decision that richer imagery is opt-in on top of the free baseline.

const ESRI_WORLD_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_DARK_GRAY =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer';
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const IMAGERY_SOURCES = [
  { id: 'dark', label: 'Dark', title: 'Esri World Dark Gray Canvas' },
  { id: 'satellite', label: 'Sat', title: 'Esri World Imagery' },
  { id: 'streets', label: 'Streets', title: 'OpenStreetMap' },
  { id: 'base', label: 'Relief', title: 'Natural Earth II (offline)' },
];

// The ctOS "mono" tone: imagery desaturated and dimmed so the map sits behind
// the data in grays, matching the UI. Applied to the base layer and to label
// overlays (core/scene/labels.js), toggled from the display menu.
export const MONO_TONE = { saturation: 0, brightness: 0.62, contrast: 1.18, gamma: 1 };
export const NATURAL_TONE = { saturation: 1, brightness: 1, contrast: 1, gamma: 1 };

export function applyTone(layer, mono) {
  if (!layer) return;
  Object.assign(layer, mono ? MONO_TONE : NATURAL_TONE);
}

/** Build the default base imagery layer (local Natural Earth II). */
export function createBaseImageryLayer() {
  return Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(
      Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
    ),
    {},
  );
}

/** Build an imagery layer for one of IMAGERY_SOURCES. */
export function createImageryLayer(source) {
  if (source === 'dark') {
    return Cesium.ImageryLayer.fromProviderAsync(
      Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_DARK_GRAY, {
        enablePickFeatures: false,
      }),
      {},
    );
  }
  if (source === 'satellite') {
    return Cesium.ImageryLayer.fromProviderAsync(
      Cesium.ArcGisMapServerImageryProvider.fromUrl(ESRI_WORLD_IMAGERY, {
        enablePickFeatures: false,
      }),
      {},
    );
  }
  if (source === 'streets') {
    return new Cesium.ImageryLayer(
      new Cesium.UrlTemplateImageryProvider({
        url: OSM_URL,
        maximumLevel: 19,
        credit: new Cesium.Credit('© OpenStreetMap contributors'),
      }),
      {},
    );
  }
  return createBaseImageryLayer();
}

/**
 * Owns the single base-imagery slot on the viewer (the bottom of the imagery
 * stack) and swaps it between sources. Only that slot changes: raster overlays
 * such as weather radar sit above it and survive a basemap switch.
 * @param {import('cesium').Viewer} viewer
 */
export function createImageryController(viewer, { mono = true } = {}) {
  let current = 'base';
  let baseLayer = viewer.imageryLayers.length ? viewer.imageryLayers.get(0) : null;
  let monoOn = mono;
  const listeners = new Set();
  // The dark canvas is already gray; toning it again would only crush it.
  const tone = () => applyTone(baseLayer, monoOn && current !== 'dark');
  tone();
  return {
    current: () => current,
    set(source) {
      if (source === current) return;
      const layers = viewer.imageryLayers;
      // Destroy the old base layer (frees its tiles), then slot the new one in
      // at the bottom so every overlay stays on top of it.
      if (baseLayer && layers.contains(baseLayer)) layers.remove(baseLayer, true);
      baseLayer = createImageryLayer(source);
      layers.add(baseLayer, 0);
      current = source;
      tone();
      listeners.forEach((fn) => fn(current));
      viewer.scene.requestRender();
    },
    mono: () => monoOn,
    setMono(on) {
      monoOn = Boolean(on);
      tone();
      listeners.forEach((fn) => fn(current));
      viewer.scene.requestRender();
    },
    /** fn(sourceId) after a basemap or tone change. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
