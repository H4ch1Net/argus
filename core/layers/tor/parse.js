// Tor relays from Onionoo (Tor Metrics), pure: the pinned query and the
// normalizer. No Cesium, no DOM: the terminal uses it too.
//
// Per the provider's documentation, not live-tested here: GET
// https://onionoo.torproject.org/details?type=relay&running=true&fields=...
// -> { relays_published, relays: [{ nickname, fingerprint, country,
// country_name, as, as_name, flags, observed_bandwidth, latitude?, longitude? }] }.
// Public relay descriptors: infrastructure, never people (the operator
// `contact` field is not requested). Onionoo geolocates relays to a country;
// coordinates are used when it gives them, otherwise each relay is placed near
// its country's centroid on a small deterministic spiral, so a country's relays
// read as a cluster rather than one stacked point. Roles: exit (the Exit flag,
// without BadExit), guard (Guard), middle (everything else).

import { COUNTRY_CENTROIDS } from '../shodan/countryCentroids.js';

export const ONIONOO_PATH = '/details';
export const ONIONOO_FIELDS =
  'nickname,fingerprint,country,country_name,as,as_name,flags,observed_bandwidth,latitude,longitude';
export const onionooQuery = () => ({
  type: 'relay',
  running: 'true',
  fields: ONIONOO_FIELDS,
});

// Countries with many relays that the shared centroid table lacks.
const MORE_CENTROIDS = {
  LU: [49.8, 6.1],
  IS: [64.9, -18.6],
  MD: [47.4, 28.4],
  LT: [55.2, 23.9],
  LV: [56.9, 24.6],
  EE: [58.6, 25.0],
  BG: [42.7, 25.5],
  SK: [48.7, 19.7],
  SI: [46.1, 14.9],
  HR: [45.1, 15.2],
  RS: [44.0, 20.9],
  CY: [35.1, 33.4],
  MT: [35.9, 14.4],
  LI: [47.16, 9.55],
  AD: [42.5, 1.6],
  MC: [43.74, 7.42],
  SC: [-4.7, 55.5],
  PA: [8.5, -80.8],
  CR: [9.7, -83.8],
  BZ: [17.2, -88.5],
  KZ: [48.0, 66.9],
  BY: [53.7, 27.9],
  GE: [42.3, 43.4],
  AM: [40.1, 45.0],
  AL: [41.2, 20.2],
  BA: [43.9, 17.7],
  MK: [41.6, 21.7],
  ME: [42.7, 19.4],
  PE: [-9.2, -75.0],
  EC: [-1.8, -78.2],
  VE: [6.4, -66.6],
  EG: [26.8, 30.8],
  MA: [31.8, -7.1],
  KE: [-0.02, 37.9],
  NG: [9.1, 8.7],
  PK: [30.4, 69.3],
  BD: [23.7, 90.4],
};

/** [lat, lon] centroid for an ISO alpha-2 code (any case), or null. */
export function countryCentroid(code) {
  const c = String(code || '').toUpperCase();
  return COUNTRY_CENTROIDS[c] ?? MORE_CENTROIDS[c] ?? null;
}

/** 'exit' | 'guard' | 'middle' from a relay's flags. */
export function relayRole(flags) {
  const f = new Set(Array.isArray(flags) ? flags : []);
  if (f.has('Exit') && !f.has('BadExit')) return 'exit';
  if (f.has('Guard')) return 'guard';
  return 'middle';
}

const text = (v, n = 64) =>
  typeof v === 'string'
    ? v
        // Control characters (U+0000-001F, U+007F-009F), spelled out: the Node 18
        // in the Android app has no Unicode property data for \p{Cc}.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .trim()
        .slice(0, n)
    : '';
const GOLDEN = 137.50776 * (Math.PI / 180);

/**
 * Onionoo details -> normalized relays. `meta.placed` is 'coordinates' or
 * 'country' (near the centroid); relays with neither are counted in
 * `unplaced` on the returned array (for the status note).
 */
export function parseOnionoo(json) {
  const relays = Array.isArray(json?.relays) ? json.relays : [];
  const out = [];
  const byCountry = new Map(); // code -> relays to spiral
  let unplaced = 0;
  const seen = new Set();
  for (const r of relays) {
    const fp = String(r?.fingerprint ?? '').toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(fp) || seen.has(fp)) continue;
    seen.add(fp);
    const country = text(r.country, 2).toLowerCase();
    const n = {
      id: `tor/${fp}`,
      type: 'relay',
      position: null,
      meta: {
        fingerprint: fp,
        nickname: text(r.nickname, 19) || 'Unnamed',
        role: relayRole(r.flags),
        flags: (Array.isArray(r.flags) ? r.flags : [])
          .map((f) => text(f, 16))
          .slice(0, 16),
        country,
        countryName: text(r.country_name, 48),
        as: text(r.as, 12),
        asName: text(r.as_name, 80),
        bandwidth: Number.isFinite(r.observed_bandwidth) ? r.observed_bandwidth : null,
        placed: 'coordinates',
        // Only the dev stand-in sets this (core/layers/tor/mockSource.js).
        demo: r.demo === true,
      },
    };
    const lat = r.latitude;
    const lon = r.longitude;
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lon) <= 180 &&
      !(lat === 0 && lon === 0)
    ) {
      n.position = { longitude: lon, latitude: lat, altitude: 0 };
      out.push(n);
    } else if (countryCentroid(country)) {
      n.meta.placed = 'country';
      if (!byCountry.has(country)) byCountry.set(country, []);
      byCountry.get(country).push(n);
    } else unplaced += 1;
  }
  // A stable spiral per country (ordered by fingerprint), at most ~3 degrees.
  for (const [code, list] of byCountry) {
    const [clat, clon] = countryCentroid(code);
    list.sort((a, b) => (a.meta.fingerprint < b.meta.fingerprint ? -1 : 1));
    const step = Math.min(0.35, 3 / Math.sqrt(list.length));
    const cosLat = Math.max(0.2, Math.cos((clat * Math.PI) / 180));
    list.forEach((n, k) => {
      const r = step * Math.sqrt(k);
      n.position = {
        longitude: clon + (r * Math.cos(k * GOLDEN)) / cosLat,
        latitude: Math.max(-85, Math.min(85, clat + r * Math.sin(k * GOLDEN))),
        altitude: 0,
      };
      out.push(n);
    });
  }
  out.unplaced = unplaced;
  out.published = text(json?.relays_published, 24);
  return out;
}
