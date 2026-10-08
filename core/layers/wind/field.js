// Wind field from Open-Meteo, pure (no Cesium): the terminal can use it too.
//
// The reference project decodes GFS/ECMWF GRIB on its own server; Argus has no
// GRIB decoder, so it asks Open-Meteo (keyless, CC BY 4.0, non-commercial
// fair use) for the current 10 m wind at a small grid of points covering the
// view, then interpolates between them. Coarse on purpose: a 8 x 6 grid per
// view is enough to drive streak particles, and each grid point counts as one
// call against Open-Meteo's daily allowance, so the proxy caps requests.
// Bilinear sampling and the "from" bearing follow gods-eye-view
// src/layers/wind/model.js and inspection.js (MIT).

export const WIND_GRID = Object.freeze({ nx: 8, ny: 6 });
export const WIND_MAX_POINTS = 64;
export const WIND_CREDIT = 'Weather data by Open-Meteo.com (CC BY 4.0)';
export const WIND_CREDIT_URL = 'https://open-meteo.com/';

const round2 = (v) => Math.round(v * 100) / 100;
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * A grid of sample points over a view box. Spans are snapped to a coarse step
 * so nearby views share one cached upstream answer.
 * @param {{ lamin: number, lomin: number, lamax: number, lomax: number,
 *   wrap?: { west: number, east: number } }} bbox
 */
export function windGrid(bbox, { nx = WIND_GRID.nx, ny = WIND_GRID.ny } = {}) {
  let west = bbox.wrap ? bbox.wrap.west : bbox.lomin;
  let east = bbox.wrap ? bbox.wrap.east : bbox.lomax;
  if (east <= west) east += 360; // across the antimeridian
  let south = Math.max(-80, bbox.lamin);
  let north = Math.min(80, bbox.lamax);
  if (north - south < 0.5) {
    const mid = (north + south) / 2;
    south = mid - 0.25;
    north = mid + 0.25;
  }
  // Snap to a power-of-two step of about 1/8 of the span (0.25 degree at the
  // finest), so nearby views land on the same grid and share a cached answer.
  const step = (span) => 0.25 * 2 ** Math.max(0, Math.ceil(Math.log2(span / 8 / 0.25)));
  const sx = step(east - west);
  const sy = step(north - south);
  west = Math.floor(west / sx) * sx;
  east = Math.ceil(east / sx) * sx;
  south = Math.max(-80, Math.floor(south / sy) * sy);
  north = Math.min(80, Math.ceil(north / sy) * sy);
  const lats = [];
  const lons = [];
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      lats.push(round2(south + ((north - south) * j) / (ny - 1)));
      lons.push(round2(wrapLon(west + ((east - west) * i) / (nx - 1))));
    }
  }
  return { nx, ny, west, east, south, north, lats, lons };
}

/**
 * The view box grown by `f` of its span on every side (latitude clamped), so
 * the fetched field covers small pans and the next request waits until the
 * view actually leaves it.
 */
export function padBbox(bbox, f = 0.3) {
  let west = bbox.wrap ? bbox.wrap.west : bbox.lomin;
  let east = bbox.wrap ? bbox.wrap.east : bbox.lomax;
  if (east <= west) east += 360;
  const dx = Math.min(90, (east - west) * f);
  const dy = (bbox.lamax - bbox.lamin) * f;
  return {
    lamin: Math.max(-85, bbox.lamin - dy),
    lamax: Math.min(85, bbox.lamax + dy),
    lomin: west - dx,
    lomax: east + dx,
    wrap: { west: west - dx, east: east + dx },
  };
}

/**
 * Whether a fetched field still serves this view: the view lies inside it and
 * the field is not much coarser than the view (zooming far in refetches).
 */
export function fieldCovers(field, bbox) {
  if (!field || !bbox) return false;
  let west = bbox.wrap ? bbox.wrap.west : bbox.lomin;
  let east = bbox.wrap ? bbox.wrap.east : bbox.lomax;
  if (east <= west) east += 360;
  while (west < field.west) {
    west += 360;
    east += 360;
  }
  while (west >= field.west + 360) {
    west -= 360;
    east -= 360;
  }
  const spanX = east - west;
  const spanY = bbox.lamax - bbox.lamin;
  return (
    east <= field.east &&
    bbox.lamin >= field.south &&
    bbox.lamax <= field.north &&
    field.east - field.west <= Math.max(4 * spanX, 2) &&
    field.north - field.south <= Math.max(4 * spanY, 2)
  );
}

/** Query params for the proxy's 'openmeteo-wind' feed. */
export function windQuery(grid) {
  return {
    latitude: grid.lats.join(','),
    longitude: grid.lons.join(','),
    current: 'wind_speed_10m,wind_direction_10m',
    wind_speed_unit: 'ms',
    timezone: 'UTC',
  };
}

/**
 * Open-Meteo multi-location answer (an array, one object per point, in request
 * order; a single object for one point) -> { ...grid, u, v, speed, time }.
 * Missing points become calm. Returns null for a malformed answer.
 */
export function parseWind(payload, grid) {
  const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const n = grid.nx * grid.ny;
  if (list.length !== n) return null;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const speed = new Float32Array(n);
  let time = null;
  for (let k = 0; k < n; k += 1) {
    const c = list[k]?.current;
    const s = Number(c?.wind_speed_10m);
    const d = Number(c?.wind_direction_10m);
    if (!Number.isFinite(s) || !Number.isFinite(d) || s < 0) continue;
    const r = (d * Math.PI) / 180;
    // Meteorological direction is where the wind comes FROM.
    u[k] = -s * Math.sin(r);
    v[k] = -s * Math.cos(r);
    speed[k] = s;
    time ??= typeof c.time === 'string' ? c.time : null;
  }
  return { ...grid, u, v, speed, time };
}

/** Bilinear wind at a point: { u, v, speed } in m/s, or null outside the grid. */
export function sampleWind(field, lon, lat) {
  if (!field) return null;
  let x = lon;
  if (field.east > 180 && x < field.west) x += 360;
  const fx = ((x - field.west) / (field.east - field.west)) * (field.nx - 1);
  const fy = ((lat - field.south) / (field.north - field.south)) * (field.ny - 1);
  if (!(fx >= 0 && fy >= 0 && fx <= field.nx - 1 && fy <= field.ny - 1)) return null;
  const i = Math.min(field.nx - 2, Math.floor(fx));
  const j = Math.min(field.ny - 2, Math.floor(fy));
  const tx = fx - i;
  const ty = fy - j;
  const at = (a, ii, jj) => a[jj * field.nx + ii];
  const lerp2 = (a) =>
    (at(a, i, j) * (1 - tx) + at(a, i + 1, j) * tx) * (1 - ty) +
    (at(a, i, j + 1) * (1 - tx) + at(a, i + 1, j + 1) * tx) * ty;
  const u = lerp2(field.u);
  const v = lerp2(field.v);
  return { u, v, speed: Math.hypot(u, v) };
}

const POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

/** The bearing the wind blows FROM, degrees clockwise from north. */
export const windFromDeg = (u, v) => ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360;

/** "12KT 270° W" style readout for a sample. */
export function formatWind(s) {
  if (!s) return '--';
  const from = windFromDeg(s.u, s.v);
  const kt = Math.round(s.speed * 1.94384);
  return `${String(kt).padStart(2, '0')}KT ${String(Math.round(from) % 360).padStart(3, '0')}° ${POINTS[Math.round(from / 22.5) % 16]}`;
}
