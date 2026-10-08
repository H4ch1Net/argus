// Air quality from the Open-Meteo Air Quality API, pure (no Cesium): the grid
// query (shared with the proxy's pin in proxy/feeds/context.js), the parser,
// bilinear sampling for a readout at the view centre, the AQI categories and
// the overlay's pixels.
//
// Keyless; data from the Copernicus Atmosphere Monitoring Service (CAMS global
// about 40 km, CAMS Europe about 10 km) served by Open-Meteo, CC BY 4.0. Per
// the provider's documentation, not live-tested here: GET
// /v1/air-quality?latitude=a,b,...&longitude=x,y,...&current=us_aqi,...&timezone=UTC
// answers one object per point (an array, in request order) with `current`.
// The same coarse view grid as the wind layer (core/layers/wind/field.js):
// each point counts against Open-Meteo's daily allowance, so it stays small.

import { windGrid, padBbox, fieldCovers } from '../wind/field.js';

export const AQ_CURRENT = 'us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide';
export const AQ_PATH = '/air-quality';
export const AQ_CREDIT =
  'Air quality: Open-Meteo.com (CC BY 4.0), contains modified Copernicus Atmosphere Monitoring Service information';

export { fieldCovers as aqFieldCovers };

/** The grid of sample points for a view (padded, snapped: shared with wind). */
export const aqGrid = (bbox) => windGrid(padBbox(bbox));

/** Query params for the proxy's 'openmeteo-aq' feed. */
export function aqQuery(grid) {
  return {
    latitude: grid.lats.join(','),
    longitude: grid.lons.join(','),
    current: AQ_CURRENT,
    timezone: 'UTC',
  };
}

const FIELDS = [
  ['usAqi', 'us_aqi'],
  ['euAqi', 'european_aqi'],
  ['pm25', 'pm2_5'],
  ['pm10', 'pm10'],
  ['o3', 'ozone'],
  ['no2', 'nitrogen_dioxide'],
];

/**
 * Open-Meteo multi-location answer -> { ...grid, usAqi, euAqi, pm25, pm10,
 * o3, no2 (Float32Array, NaN where missing), time, count } or null.
 */
export function parseAirQuality(payload, grid) {
  const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const n = grid.nx * grid.ny;
  if (list.length !== n) return null;
  const out = { ...grid, time: null, count: 0 };
  for (const [k] of FIELDS) out[k] = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i += 1) {
    const c = list[i]?.current;
    if (!c) continue;
    let any = false;
    for (const [k, src] of FIELDS) {
      const v = Number(c[src]);
      if (c[src] != null && Number.isFinite(v) && v >= 0) {
        out[k][i] = v;
        any = true;
      }
    }
    if (any) out.count += 1;
    out.time ??= typeof c.time === 'string' ? c.time.slice(0, 20) : null;
  }
  return out.count ? out : null;
}

/** Bilinear value of one array at a point; NaN corners are left out. */
function bilinear(field, a, lon, lat) {
  let x = lon;
  if (field.east > 180 && x < field.west) x += 360;
  const fx = ((x - field.west) / (field.east - field.west)) * (field.nx - 1);
  const fy = ((lat - field.south) / (field.north - field.south)) * (field.ny - 1);
  if (!(fx >= 0 && fy >= 0 && fx <= field.nx - 1 && fy <= field.ny - 1)) return NaN;
  const i = Math.min(field.nx - 2, Math.floor(fx));
  const j = Math.min(field.ny - 2, Math.floor(fy));
  const tx = fx - i;
  const ty = fy - j;
  let sum = 0;
  let wsum = 0;
  for (const [ii, jj, w] of [
    [i, j, (1 - tx) * (1 - ty)],
    [i + 1, j, tx * (1 - ty)],
    [i, j + 1, (1 - tx) * ty],
    [i + 1, j + 1, tx * ty],
  ]) {
    const v = a[jj * field.nx + ii];
    if (Number.isNaN(v) || w === 0) continue;
    sum += v * w;
    wsum += w;
  }
  return wsum > 0 ? sum / wsum : NaN;
}

const orNull = (v) => (Number.isFinite(v) ? v : null);

/** Air quality at a point: { usAqi, euAqi, pm25, pm10, o3, no2 } or null outside. */
export function sampleAirQuality(field, lon, lat) {
  if (!field) return null;
  const s = {};
  let any = false;
  for (const [k] of FIELDS) {
    s[k] = orNull(bilinear(field, field[k], lon, lat));
    if (s[k] != null) any = true;
  }
  return any ? s : null;
}

// US EPA AQI categories and their official colours (a state legend, used as is).
export const AQI_CATEGORIES = Object.freeze([
  { max: 50, label: 'Good', short: 'GOOD', color: '#00e400' },
  { max: 100, label: 'Moderate', short: 'MOD', color: '#ffff00' },
  {
    max: 150,
    label: 'Unhealthy for sensitive groups',
    short: 'USG',
    color: '#ff7e00',
  },
  { max: 200, label: 'Unhealthy', short: 'UNHLTHY', color: '#ff0000' },
  { max: 300, label: 'Very unhealthy', short: 'V UNHLTHY', color: '#8f3f97' },
  { max: Infinity, label: 'Hazardous', short: 'HAZ', color: '#7e0023' },
]);

/** The category for a US AQI value (null for none). */
export function aqiCategory(aqi) {
  if (!Number.isFinite(aqi) || aqi < 0) return null;
  return AQI_CATEGORIES.find((c) => Math.round(aqi) <= c.max);
}

/** Status-strip readout: "AQI 42 GOOD" (US AQI), or "--". */
export function formatAirQuality(s) {
  if (!s || s.usAqi == null) return '--';
  return `AQI ${Math.round(s.usAqi)} ${aqiCategory(s.usAqi).short}`;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const CATEGORY_RGB = AQI_CATEGORIES.map((c) => rgb(c.color));

/**
 * RGBA pixels (row 0 = north) over the field's box [west, south, east,
 * north]: each pixel the category colour of the interpolated US AQI, soft
 * toward the box edges; transparent where nothing was measured.
 */
export function airQualityPixels(field, width = 128, height = 96, alpha = 150) {
  const px = new Uint8ClampedArray(width * height * 4);
  if (!field) return px;
  const lonSpan = field.east - field.west;
  for (let j = 0; j < height; j += 1) {
    const lat = field.north - ((j + 0.5) / height) * (field.north - field.south);
    const ey = Math.min(j + 0.5, height - j - 0.5) / (height * 0.06);
    for (let i = 0; i < width; i += 1) {
      const lon = field.west + ((i + 0.5) / width) * lonSpan;
      const aqi = bilinear(field, field.usAqi, lon, lat);
      if (!Number.isFinite(aqi)) continue;
      const cat = AQI_CATEGORIES.findIndex((c) => Math.round(aqi) <= c.max);
      const [r, g, b] = CATEGORY_RGB[cat];
      const ex = Math.min(i + 0.5, width - i - 0.5) / (width * 0.06);
      const edge = Math.min(1, ex, ey);
      const k = (j * width + i) * 4;
      px[k] = r;
      px[k + 1] = g;
      px[k + 2] = b;
      px[k + 3] = alpha * edge;
    }
  }
  return px;
}
