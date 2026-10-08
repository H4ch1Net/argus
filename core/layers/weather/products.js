// Observed-weather imagery from NOAA nowCOAST (GeoServer WMS): global infrared
// clouds, GOES regional infrared, US radar and lightning density, as raster
// specs for the SDK's raster renderType. Services, layer names and styles are
// the ones the reference project uses. Requests go through the proxy feed
// 'nowcoast'. Pure: builds plain spec objects.
//
// Without a TIME parameter GeoServer serves each layer's latest time step. The
// `_` parameter is a refresh bucket: it changes once per refresh interval, so
// the raster engine reloads the tiles then (and the browser cache serves the
// rest of the time); GeoServer ignores parameters it does not know. With a
// time (an instant the layer advertises, see capabilities.js and the weather
// timeline), the frame is fixed and the time itself is its identity.

import { isoInstant } from './capabilities.js';

const MINUTE = 60_000;

export const WEATHER_PRODUCTS = {
  clouds: {
    service: 'satellite',
    layers: 'global_longwave_imagery_mosaic',
    styles: 'reflectance',
    label: 'Infrared clouds (global)',
    refreshMs: 10 * MINUTE,
    alpha: 0.55,
    // Hourly, 2 to 3 h behind: a frame up to 3 h old still stands for a time.
    maxGapMs: 180 * MINUTE,
    metadataTtlMs: 2 * MINUTE,
  },
  goes: {
    // GOES-East/West band 14 longwave infrared, about 5-minute updates.
    service: 'satellite',
    layers: 'goes_longwave_imagery',
    styles: 'goes-lir',
    label: 'Infrared clouds (GOES, Americas)',
    refreshMs: 5 * MINUTE,
    alpha: 0.55,
    maxGapMs: 30 * MINUTE,
    metadataTtlMs: 2 * MINUTE,
  },
  radar: {
    service: 'weather_radar',
    layers: 'conus_base_reflectivity_mosaic',
    styles: 'weather_radar_base_reflectivity',
    label: 'Radar reflectivity (US)',
    refreshMs: 5 * MINUTE,
    alpha: 0.75,
    // Contiguous US mosaic: no point requesting tiles elsewhere.
    rectangle: [-127, 20, -65, 52],
    maxGapMs: 30 * MINUTE,
    metadataTtlMs: 2 * MINUTE,
  },
  lightning: {
    // A derived density product NOAA may redistribute (not raw detections).
    // Covers the Americas and the Pacific; empty elsewhere.
    service: 'lightning_detection',
    layers: 'ldn_lightning_strike_density',
    styles: 'lightning_density',
    label: 'Lightning density (Americas, Pacific)',
    refreshMs: 10 * MINUTE,
    alpha: 0.8,
    maxGapMs: 30 * MINUTE,
    metadataTtlMs: 10 * MINUTE,
  },
};

/** Sub-path of a product's WMS service under the proxy feed 'nowcoast'. */
export function weatherServicePath(productId) {
  const p = WEATHER_PRODUCTS[productId];
  if (!p) throw new Error(`unknown weather product: ${productId}`);
  return `/${p.service}/ows`;
}

/**
 * @param {keyof typeof WEATHER_PRODUCTS} productId
 * @param {(feedId: string, path: string) => string} buildUrl  the proxy client's
 * @param {number} [now]
 * @param {string | { time?: string|null, maximumLevel?: number }} [opts]
 *   an advertised observation instant (or { time }) pins the frame; without
 *   one the layer's latest step is served. maximumLevel caps tile detail
 *   (5 on a phone keeps a frame's tile count down).
 */
export function weatherSpec(productId, buildUrl, now = Date.now(), opts = {}) {
  const p = WEATHER_PRODUCTS[productId];
  if (!p) throw new Error(`unknown weather product: ${productId}`);
  const { time = null, maximumLevel = 7 } =
    typeof opts === 'string' ? { time: opts } : (opts ?? {});
  let frameTime = null;
  if (time != null) {
    frameTime = isoInstant(time);
    if (!frameTime) throw new Error(`weather time must be a UTC instant: ${time}`);
  }
  return {
    kind: 'wms',
    url: buildUrl('nowcoast', weatherServicePath(productId)),
    layers: p.layers,
    parameters: {
      styles: p.styles,
      format: 'image/png',
      transparent: true,
      ...(frameTime ? { time: frameTime } : { _: String(Math.floor(now / p.refreshMs)) }),
    },
    label: p.label,
    credit: 'NOAA nowCOAST',
    rectangle: p.rectangle,
    maximumLevel,
    time: frameTime,
  };
}
