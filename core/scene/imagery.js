import * as Cesium from 'cesium';

// Base imagery + imagery switching.
//
// The default is the Natural Earth II tiles that ship inside the Cesium package
// (Assets/Textures/NaturalEarthII): no token, no network, offline, no secrets, so
// the globe always starts. It is a coarse whole-world basemap with NO street-level
// detail, so two higher-resolution sources sit on top of it as an explicit choice:
//
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
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const IMAGERY_SOURCES = [
  { id: 'base', label: 'Relief' },
  { id: 'satellite', label: 'Satellite' },
  { id: 'streets', label: 'Streets' },
];

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
 * Owns the single base-imagery slot on the viewer and swaps it between sources.
 * @param {import('cesium').Viewer} viewer
 */
export function createImageryController(viewer) {
  let current = 'base';
  return {
    current: () => current,
    set(source) {
      if (source === current) return;
      const layers = viewer.imageryLayers;
      layers.removeAll(true); // destroy the old base layer (frees its tiles)
      layers.add(createImageryLayer(source));
      current = source;
      viewer.scene.requestRender();
    },
  };
}
