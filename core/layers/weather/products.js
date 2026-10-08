// Observed-weather imagery from NOAA nowCOAST (GeoServer WMS): global infrared
// clouds, US radar and lightning density, as raster specs
// for the SDK's raster renderType. Services, layer names and styles are the ones
// the reference project uses. Requests go through the proxy feed 'nowcoast'.
// Pure: builds plain spec objects.
//
// Without a TIME parameter GeoServer serves each layer's latest time step. The
// `_` parameter is a refresh bucket: it changes once per refresh interval, so
// the raster engine reloads the tiles then (and the browser cache serves the
// rest of the time); GeoServer ignores parameters it does not know.

export const WEATHER_PRODUCTS = {
  clouds: {
    service: 'satellite',
    layers: 'global_longwave_imagery_mosaic',
    styles: 'reflectance',
    label: 'Infrared clouds (global)',
    refreshMs: 10 * 60 * 1000,
    alpha: 0.55,
  },
  radar: {
    service: 'weather_radar',
    layers: 'conus_base_reflectivity_mosaic',
    styles: 'weather_radar_base_reflectivity',
    label: 'Radar reflectivity (US)',
    refreshMs: 5 * 60 * 1000,
    alpha: 0.75,
    // Contiguous US mosaic: no point requesting tiles elsewhere.
    rectangle: [-127, 20, -65, 52],
  },
  lightning: {
    // A derived density product NOAA may redistribute (not raw detections).
    // Covers the Americas and the Pacific; empty elsewhere.
    service: 'lightning_detection',
    layers: 'ldn_lightning_strike_density',
    styles: 'lightning_density',
    label: 'Lightning density (Americas, Pacific)',
    refreshMs: 10 * 60 * 1000,
    alpha: 0.8,
  },
};

/**
 * @param {keyof typeof WEATHER_PRODUCTS} productId
 * @param {(feedId: string, path: string) => string} buildUrl  the proxy client's
 * @param {number} [now]
 */
export function weatherSpec(productId, buildUrl, now = Date.now()) {
  const p = WEATHER_PRODUCTS[productId];
  if (!p) throw new Error(`unknown weather product: ${productId}`);
  return {
    kind: 'wms',
    url: buildUrl('nowcoast', `/${p.service}/ows`),
    layers: p.layers,
    parameters: {
      styles: p.styles,
      format: 'image/png',
      transparent: true,
      _: String(Math.floor(now / p.refreshMs)),
    },
    label: p.label,
    credit: 'NOAA nowCOAST',
    rectangle: p.rectangle,
    maximumLevel: 7,
  };
}
