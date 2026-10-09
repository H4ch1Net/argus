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
// Sentinel-2 cloudless, NASA Blue Marble and Black Marble and OpenTopoMap add
// more of the Earth (a cloud-free satellite mosaic, relief and bathymetry, the
// planet at night, contours). These load their tiles directly (HTTPS + CORS-enabled, so no mixed-content
// block on mobile); proxy-side tile caching is a possible later optimization. They
// are off by default (cellular-friendly, per the mobile constraints), matching the
// locked decision that richer imagery is opt-in on top of the free baseline.

const ESRI_WORLD_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const ESRI_DARK_GRAY =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer';
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
// Sentinel-2 cloudless (EOX IT Services, s2maps.eu): a cloud-free 10 m mosaic.
// The 2016 edition is CC BY 4.0; later editions are CC BY-NC-SA 4.0 (personal,
// non-commercial use, which is this project). Web Mercator tiles (matrix set
// 'g'), keyless. Per the provider's documentation, not live-tested here.
const EOX_S2 =
  'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg';
// NASA GIBS (keyless, public domain): Blue Marble shaded relief and bathymetry
// by day, VIIRS Black Marble night lights.
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const GIBS_BLUE_MARBLE = `${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`;
const GIBS_BLACK_MARBLE = `${GIBS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`;
// OpenTopoMap (CC BY-SA, OpenStreetMap data and SRTM): contours and hillshade.
const OPENTOPOMAP = 'https://tile.opentopomap.org/{z}/{x}/{y}.png';

export const IMAGERY_SOURCES = [
  {
    id: 'dark',
    label: 'Dark',
    title:
      'ctOS dark map: OpenStreetMap vector tiles (OpenFreeMap), sharp to street level',
  },
  {
    id: 'satellite',
    label: 'Sat',
    title: 'Esri World Imagery (aerial, to street level)',
  },
  { id: 'sentinel', label: 'S2', title: 'Sentinel-2 cloudless (EOX), 10 m, cloud free' },
  {
    id: 'bluemarble',
    label: 'Blue',
    title: 'NASA Blue Marble with relief and bathymetry',
  },
  { id: 'blackmarble', label: 'Night', title: 'NASA Black Marble: city lights at night' },
  { id: 'topo', label: 'Topo', title: 'OpenTopoMap: contours and hillshade' },
  { id: 'streets', label: 'Streets', title: 'OpenStreetMap' },
  { id: 'base', label: 'Relief', title: 'Natural Earth II (offline)' },
];

/** Already dark or toned at the source: the mono tone would only crush them. */
const SELF_TONED = new Set(['dark', 'blackmarble']);

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

// The ctOS vector basemap (core/scene/vector/): set by main once the proxy
// is known. With it, "dark" is drawn from OpenStreetMap vector tiles, sharp
// to street level with buildings; without it (no proxy, a dev mock), the Esri
// dark canvas below, which stops at about zoom 16.
let vectorBasemap = null;
let VectorProvider = null;
/**
 * @param {ReturnType<import('./vector/client.js').createVectorBasemap>|null} basemap
 * @param {typeof import('./vector/provider.js').VectorTileImageryProvider} [Provider]
 */
export function setVectorBasemap(basemap, Provider) {
  vectorBasemap = basemap;
  if (Provider) VectorProvider = Provider;
}
/** The vector basemap's provider of one kind, or null without it. */
export function vectorProvider(kind) {
  return vectorBasemap && VectorProvider
    ? new VectorProvider({ basemap: vectorBasemap, kind })
    : null;
}

/** Build an imagery layer for one of IMAGERY_SOURCES. */
export function createImageryLayer(source) {
  if (source === 'dark') {
    const vector = vectorProvider('base');
    if (vector) return new Cesium.ImageryLayer(vector, {});
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
  const template = {
    sentinel: {
      url: EOX_S2,
      maximumLevel: 15,
      credit:
        'Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data)',
    },
    bluemarble: {
      url: GIBS_BLUE_MARBLE,
      maximumLevel: 8,
      credit: 'NASA Blue Marble (GIBS)',
    },
    blackmarble: {
      url: GIBS_BLACK_MARBLE,
      maximumLevel: 8,
      credit: 'NASA Black Marble, VIIRS night lights (GIBS)',
    },
    topo: {
      url: OPENTOPOMAP,
      maximumLevel: 17,
      credit: '© OpenTopoMap (CC BY-SA), © OpenStreetMap contributors, SRTM',
    },
  }[source];
  if (template) {
    return new Cesium.ImageryLayer(
      new Cesium.UrlTemplateImageryProvider({
        url: template.url,
        maximumLevel: template.maximumLevel,
        credit: new Cesium.Credit(template.credit),
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
  // The dark canvas is already gray and night lights are dark by nature;
  // toning them again would only crush them.
  const tone = () => applyTone(baseLayer, monoOn && !SELF_TONED.has(current));
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
    /** Rebuild the current base layer (e.g. after the vector basemap failed). */
    reload() {
      const source = current;
      current = null;
      this.set(source);
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
