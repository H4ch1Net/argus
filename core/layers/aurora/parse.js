// Aurora forecast from NOAA SWPC, pure (no Cesium, no DOM): the OVATION
// nowcast grid and the planetary K index, plus the overlay's pixels.
//
// Per the provider's documentation, not live-tested here:
//   /json/ovation_aurora_latest.json -> { "Observation Time", "Forecast Time",
//     "Data Format": "[Longitude, Latitude, Aurora]", coordinates: [[lon, lat, p], ...] }
//     a 1 degree grid, longitude 0..359, latitude -90..90, p = probability of
//     visible aurora in percent (0..100).
//   /json/planetary_k_index_1m.json -> [{ time_tag, kp_index, estimated_kp, kp }, ...]
// Both keyless, US public domain. The K index parser also reads the older
// products/noaa-planetary-k-index.json table shape ([header row, rows...]).

import { INK } from '../../ui/palette.js';

// Sub-paths under the proxy's 'swpc' feed (based at services.swpc.noaa.gov/json).
export const AURORA_PATH = '/ovation_aurora_latest.json';
export const KP_PATH = '/planetary_k_index_1m.json';

const NX = 360;
const NY = 181; // latitude -90..90

/**
 * OVATION answer -> { nx, ny, values (Float32Array, row = lat + 90, col = lon
 * 0..359), observed, forecast, max, count } or null when malformed.
 */
export function parseOvation(json) {
  const rows = Array.isArray(json?.coordinates) ? json.coordinates : null;
  if (!rows || rows.length < 1000) return null;
  const values = new Float32Array(NX * NY);
  let max = 0;
  let count = 0;
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 3) continue;
    const lon = Math.round(Number(r[0]));
    const lat = Math.round(Number(r[1]));
    const p = Number(r[2]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(p)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 360) continue;
    const col = ((lon % 360) + 360) % 360;
    const v = Math.max(0, Math.min(100, p));
    values[(lat + 90) * NX + col] = v;
    if (v > max) max = v;
    count += 1;
  }
  if (count < 1000) return null;
  const when = (k) => (typeof json[k] === 'string' ? json[k].slice(0, 32) : null);
  return {
    nx: NX,
    ny: NY,
    values,
    observed: when('Observation Time'),
    forecast: when('Forecast Time'),
    max,
    count,
  };
}

/** The latest planetary K index: { kp, time } or null. */
export function parseKp(json) {
  if (!Array.isArray(json) || !json.length) return null;
  let best = null;
  const take = (kp, time) => {
    const v = Number(kp);
    if (Number.isFinite(v) && v >= 0 && v <= 9)
      best = { kp: v, time: String(time ?? '').slice(0, 32) };
  };
  if (Array.isArray(json[0])) {
    // [["time_tag", "Kp", ...], ["2026-10-08 09:00:00.000", "2.33", ...], ...]
    const head = json[0].map((h) => String(h).toLowerCase());
    const k = head.findIndex(
      (h) => h === 'kp' || h === 'kp_index' || h === 'estimated_kp',
    );
    const t = head.indexOf('time_tag');
    if (k < 0) return null;
    for (const row of json.slice(1)) if (Array.isArray(row)) take(row[k], row[t]);
    return best;
  }
  for (const r of json) {
    if (!r || typeof r !== 'object') continue;
    take(r.estimated_kp ?? r.kp_index ?? r.Kp ?? r.kp, r.time_tag);
  }
  return best;
}

/** Probability (0..100) at a point, bilinear between grid nodes. */
export function sampleOvation(grid, lon, lat) {
  if (!grid || !Number.isFinite(lon) || !Number.isFinite(lat)) return 0;
  const x = ((lon % 360) + 360) % 360;
  const y = Math.max(0, Math.min(NY - 1, lat + 90));
  const x0 = Math.floor(x) % NX;
  const x1 = (x0 + 1) % NX;
  const y0 = Math.floor(y);
  const y1 = Math.min(NY - 1, y0 + 1);
  const tx = x - Math.floor(x);
  const ty = y - y0;
  const v = (c, r) => grid.values[r * NX + c];
  return (
    (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) +
    (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty
  );
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const MINT = hex(INK.mint);
const WHITE = hex(INK.white);

/**
 * RGBA pixels (row 0 = north) of an equirectangular overlay covering the
 * globe (-180..180, 90..-90): mint where aurora is likely, brighter toward
 * white above 50 %, transparent below 3 %.
 */
export function auroraPixels(grid, width = 360, height = 180) {
  const px = new Uint8ClampedArray(width * height * 4);
  if (!grid) return px;
  for (let j = 0; j < height; j += 1) {
    const lat = 90 - ((j + 0.5) * 180) / height;
    // Aurora lives poleward of about 40 degrees: skip the rest of the globe.
    if (Math.abs(lat) < 35) continue;
    for (let i = 0; i < width; i += 1) {
      const lon = -180 + ((i + 0.5) * 360) / width;
      const p = sampleOvation(grid, lon, lat);
      if (p < 3) continue;
      const a = Math.min(1, (p - 3) / 37) ** 0.8;
      const w = Math.max(0, Math.min(1, (p - 50) / 40));
      const k = (j * width + i) * 4;
      px[k] = MINT[0] + (WHITE[0] - MINT[0]) * w;
      px[k + 1] = MINT[1] + (WHITE[1] - MINT[1]) * w;
      px[k + 2] = MINT[2] + (WHITE[2] - MINT[2]) * w;
      px[k + 3] = 30 + 190 * a;
    }
  }
  return px;
}

/** "12:50Z" from an ISO-ish time, or ''. */
export function hhmmZ(t) {
  const m = /T(\d{2}:\d{2})/.exec(String(t ?? ''));
  return m ? `${m[1]}Z` : '';
}

/** Status line: "Kp 3.3, forecast 12:50Z". */
export function auroraNote(field) {
  if (!field) return '';
  const parts = [];
  if (field.kp) parts.push(`Kp ${field.kp.kp.toFixed(1)}`);
  const fc = hhmmZ(field.forecast);
  if (fc) parts.push(`forecast ${fc}`);
  return parts.join(', ');
}

/** Readout for a sample: "12% Kp 3.3". */
export function formatAurora(s) {
  if (!s) return '--';
  return `${Math.round(s.probability)}%${s.kp != null ? ` Kp ${s.kp.toFixed(1)}` : ''}`;
}
