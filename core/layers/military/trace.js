// Military 24 h trail backfill: adsb.lol's per-aircraft trace file (the one its
// own map loads, readsb globe_history format) turned into SDK fixes, so a
// selected military aircraft's trail reaches back up to a day instead of only
// to when the layer was switched on. Holding patterns and orbits at their real
// altitude then show up as stacked loops.
// Adapted from gods-eye-view src/sources/live/aircraft.js normalizeAircraftTrack
// and src/layers/military/tracking.js _backfillTrail (MIT).
//
// Upstream (proxy feed 'adsblol-trace'): /data/traces/<last 2 hex>/trace_full_<hex>.json,
// an UNDOCUMENTED path, ODbL ("adsb.lol"). Response:
//   { icao, timestamp (s), trace: [[dt_s, lat, lon, alt_ft | 'ground' | null,
//     gs, track, flags, vrate, details | null, type, alt_geom_ft | null, ...]] }
// Only time, position and altitude are read. The per-point details object
// (which can carry registration and owner fields) is never touched.
//
// Pure: the proxy client is injected. Public ADS-B only, already published.

const FT_TO_M = 0.3048;
const HEX = /^~?[0-9a-f]{6}$/;

/** Proxy sub-path of an aircraft's trace file, or null for a bad address. */
export function tracePath(hex) {
  const h = String(hex ?? '')
    .trim()
    .toLowerCase();
  if (!HEX.test(h)) return null;
  return `/data/traces/${h.slice(-2)}/trace_full_${h}.json`;
}

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Trace -> fixes, oldest first, for the SDK's backfill hook.
 * @param {{ icao?: string, timestamp?: number, trace?: any[][] }} payload
 * @param {{ before?: number, maxPoints?: number, hex?: string }} [opts]
 *   before: keep only points strictly older than this (ms), e.g. the oldest live fix;
 *   maxPoints: stride-thin to at most this many (the newest point is always kept);
 *   hex: when given, a trace for another aircraft yields nothing
 * @returns {{ t: number, longitude: number, latitude: number, altitude: number }[]}
 *   t in ms; altitude in metres (geometric when reported, else barometric, as the
 *   live layer uses; 'ground' is 0; a missing altitude carries the previous one)
 */
export function traceToFixes(
  payload,
  { before = Infinity, maxPoints = 400, hex = null } = {},
) {
  const base = finite(payload?.timestamp);
  const rows = Array.isArray(payload?.trace) ? payload.trace : [];
  if (base === null || !rows.length) return [];
  if (hex && typeof payload.icao === 'string') {
    const norm = (s) => String(s).trim().toLowerCase().replace(/^~/, '');
    if (norm(payload.icao) !== norm(hex)) return [];
  }
  const points = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const dt = finite(row[0]);
    const latitude = finite(row[1]);
    const longitude = finite(row[2]);
    if (dt === null || latitude === null || longitude === null) continue;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue;
    const t = Math.round((base + dt) * 1000);
    if (!(t < before)) continue;
    const geom = finite(row[10]);
    const baro = finite(row[3]);
    const altitude =
      geom !== null
        ? geom * FT_TO_M
        : baro !== null
          ? baro * FT_TO_M
          : row[3] === 'ground'
            ? 0
            : null;
    points.push({ t, longitude, latitude, altitude });
  }
  points.sort((a, b) => a.t - b.t);
  // Missing altitudes: carry the previous one forward; leading gaps take the
  // first known one (never a made-up dive to the ground).
  let last = null;
  for (const p of points) {
    if (p.altitude === null) p.altitude = last;
    else last = p.altitude;
  }
  const first = points.find((p) => p.altitude !== null)?.altitude ?? 0;
  for (const p of points) if (p.altitude === null) p.altitude = first;
  return thin(points, maxPoints);
}

// Every k-th point, counted back from the newest so the join with the live
// trail is never thinned away.
function thin(points, maxPoints) {
  const max = Math.max(1, Math.floor(maxPoints));
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out = [];
  for (let i = points.length - 1; i >= 0 && out.length < max; i -= stride)
    out.push(points[i]);
  return out.reverse();
}

/**
 * Fetch and convert one aircraft's trace through the proxy.
 * @param {{ proxyClient: { getJson: Function }, hex: string, before?: number,
 *   maxPoints?: number, signal?: AbortSignal }} o
 * @returns {Promise<{ t: number, longitude: number, latitude: number, altitude: number }[]>}
 *   [] for a bad address or an aircraft with no trace (the upstream 404s)
 */
export async function fetchTraceFixes({ proxyClient, hex, before, maxPoints, signal }) {
  const path = tracePath(hex);
  if (!path) return [];
  try {
    const raw = await proxyClient.getJson('adsblol-trace', path, { signal });
    return traceToFixes(raw, { before, maxPoints, hex });
  } catch (err) {
    if (err?.status === 404) return [];
    throw err;
  }
}
