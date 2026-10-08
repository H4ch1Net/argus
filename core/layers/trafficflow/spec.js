// Traffic flow: TomTom's raster flow tiles (road lines coloured by current speed
// against free-flow speed) as a raster spec for the SDK's raster renderType.
// Requests go through the proxy feed 'tomtom-flow' (proxy/feeds/imagery.js),
// which injects TOMTOM_API_KEY server side and caps tiles at 6,000 a day. Pure.
//
// Adapted from gods-eye-view server/providers/traffic.js (MIT): the reference
// fetches TomTom's flow VECTOR tiles to drive a synthetic vehicle simulation.
// Argus shows only the real measurement, as raster tiles; the simulated
// vehicles are not ported (fabricated data). The raster path and style names
// follow TomTom's documented Raster Flow Tiles pattern, unverified offline.

/** Raster flow styles TomTom documents; relative0 is speed / free-flow speed. */
export const TRAFFIC_FLOW_STYLES = [
  'relative0',
  'relative0-dark',
  'relative',
  'absolute',
  'relative-delay',
  'reduced-sensitivity',
];

/** Attribution TomTom requires wherever the tiles are shown. */
export const TRAFFIC_FLOW_CREDIT = 'Traffic flow data © TomTom';

/**
 * How often the layer re-requests its tiles. Every refresh of the visible tiles
 * spends the daily tile budget (the proxy cache absorbs repeats within 120 s),
 * so it is far slower than TomTom's own update cadence.
 */
export const TRAFFIC_FLOW_REFRESH_MS = 10 * 60 * 1000;

/**
 * Deepest zoom requested: street-level lines are legible by z17, and every
 * level deeper multiplies the tiles a view costs. Cesium upsamples past it.
 */
export const TRAFFIC_FLOW_MAX_LEVEL = 17;

/**
 * @param {(feedId: string, path: string) => string} buildUrl  the proxy client's
 * @param {{ style?: string, now?: number }} [opts]
 */
export function trafficFlowSpec(
  buildUrl,
  { style = 'relative0', now = Date.now() } = {},
) {
  if (!TRAFFIC_FLOW_STYLES.includes(style)) {
    throw new Error(`unknown traffic flow style: ${style}`);
  }
  // The {z}/{x}/{y} template is appended after buildUrl so its braces stay literal.
  const base = buildUrl('tomtom-flow', `/${style}`).replace(/\/+$/, '');
  return {
    kind: 'xyz',
    url: `${base}/{z}/{x}/{y}.png`,
    maximumLevel: TRAFFIC_FLOW_MAX_LEVEL,
    credit: TRAFFIC_FLOW_CREDIT,
    label: 'Traffic flow (TomTom)',
    // Same URL every time; the bucket in the key makes the engine reload the
    // tiles once per refresh interval.
    key: `tomtom-flow ${style} ${Math.floor(now / TRAFFIC_FLOW_REFRESH_MS)}`,
  };
}
