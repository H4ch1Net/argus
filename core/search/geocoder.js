// Place geocoding for global search fly-to. The chain:
//   1. the bundled offline places (core/search/places.js): an exact name,
//      "name, country" or alias answers with no request at all;
//   2. Photon (komoot) through the proxy feed 'photon', biased to `near`
//      (the user, else the view centre);
//   3. for a numbered street address, the address geocoders beside it
//      (./address.js: US Census, else Nominatim around the user);
//   4. OSM Nominatim through the proxy feed 'nominatim', the last resort.
// The network answers are ranked local first (./rank.js), and offline prefix
// matches lead them. parseNominatim is pure and tested; createGeocoder wires
// the chain to the proxy client. Inputs are places, never people.

import { searchPlaces, normalizePlaceName } from './places.js';
import { PHOTON_FEED, PHOTON_PATH, photonParams, parsePhoton } from './photon.js';
import { lookupAddress, parseAddress } from './address.js';
import { rankPlaces } from './rank.js';

export function parseNominatim(json) {
  const arr = Array.isArray(json) ? json : [];
  return arr
    .map((p) => ({
      name: p.display_name,
      longitude: Number(p.lon),
      latitude: Number(p.lat),
    }))
    .filter((p) => p.name && Number.isFinite(p.longitude) && Number.isFinite(p.latitude));
}

const firstPart = (name) => normalizePlaceName(String(name).split(',')[0]);

function closeKm(a, b) {
  const dLat = (a.latitude - b.latitude) * 111.2;
  const dLon =
    (a.longitude - b.longitude) * 111.2 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/**
 * Offline hits first (at most two when the network also answered), then
 * network hits that are not the same place again (same leading name within 10 km).
 */
export function mergePlaces(offline, network, limit = 5) {
  const lead = network.length ? offline.slice(0, 2) : offline;
  const rest = network.filter(
    (n) =>
      !lead.some((o) => firstPart(o.name) === firstPart(n.name) && closeKm(o, n) < 10),
  );
  return [...lead, ...rest].slice(0, limit);
}

/**
 * @param {{ getJson: Function } | null} proxyClient  null: offline places only
 * @param {{ near?: (() => ({lat:number, lon:number}|null)) | {lat:number, lon:number} | null,
 *   photon?: boolean, limit?: number }} [opts]
 *   near: the view centre, sent to Photon as a soft proximity bias
 * @returns {(query: string, signal?: AbortSignal) => Promise<Array<{ name: string,
 *   latitude: number, longitude: number }>>}
 */
export function createGeocoder(
  proxyClient,
  { near = null, photon = true, limit = 5 } = {},
) {
  return async (query, signal) => {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const offline = searchPlaces(q, { limit });
    if (!proxyClient || offline.some((p) => p.exact)) return offline;

    let network = [];
    let failure = null;
    const bias = validNear(typeof near === 'function' ? near() : near);
    // A numbered street address: the address geocoders, beside Photon.
    const addresses = parseAddress(q)
      ? lookupAddress(proxyClient, q, { near: bias, signal })
          .then((list) => list.map(toResult))
          .catch((err) => {
            if (signal?.aborted) throw err;
            return [];
          })
      : Promise.resolve([]);
    if (photon) {
      try {
        network = parsePhoton(
          await proxyClient.getJson(PHOTON_FEED, PHOTON_PATH, {
            params: photonParams(q, bias, limit),
            signal,
          }),
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        failure = err;
      }
    }
    if (!network.length) {
      try {
        network = parseNominatim(
          await proxyClient.getJson('nominatim', '/search', {
            params: { q, format: 'json', limit },
            signal,
          }),
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        failure = err;
      }
    }
    network = rankLabels(q, [...(await addresses), ...network], bias);
    // Nothing anywhere and a feed failed: say why rather than "no results".
    if (!network.length && !offline.length && failure) throw failure;
    return mergePlaces(offline, network, limit);
  };
}

function validNear(near) {
  const lat = Number(near?.lat ?? near?.latitude);
  const lon = Number(near?.lon ?? near?.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90
    ? { lat, lon }
    : null;
}

/** An address Place (./address.js) as a geocoder result. */
const toResult = (p) => ({
  name: [p.name, p.detail].filter(Boolean).join(', '),
  latitude: p.lat,
  longitude: p.lon,
  kind: p.kind ?? null,
  source: p.id?.split(':')[0] ?? 'address',
});

/**
 * Rank geocoder results local first: each one-line label is scored as its
 * name (before the first comma) and where it is (the rest).
 */
export function rankLabels(query, results, near) {
  const split = results.map((r) => {
    const [name, ...rest] = String(r.name).split(',');
    return {
      r,
      name: name.trim(),
      detail: rest.join(','),
      kind: r.kind,
      lat: r.latitude,
      lon: r.longitude,
    };
  });
  return rankPlaces(query, split, { near }).map((x) => x.r);
}
