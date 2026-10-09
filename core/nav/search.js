// Destination search for navigation: the bundled offline places, Photon
// (komoot, OSM data) through the proxy, and TomTom fuzzy search when the proxy
// holds a TomTom key, all biased near the user (or the view centre), merged
// into Places: { id, name, detail, lat, lon, kind }. Pure apart from the
// injected proxy client: every shell shares it. Inputs are places and
// addresses, never people.
//
// TomTom Search (search/2/search, feed 'tomtom-search') is per the provider's
// documentation, not live-tested here (no key in this environment). Photon's
// parser is tested against a real answer (test/fixtures/photon.json).

import { searchPlaces } from '../search/places.js';
import { PHOTON_FEED, PHOTON_PATH, photonParams } from '../search/photon.js';
import { haversineM } from './geo.js';

export const TOMTOM_SEARCH_FEED = 'tomtom-search';
export const SEARCH_QUERY_MAX = 100;

const text = (v, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const onGlobe = (lat, lon) =>
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180;

function uniqueJoin(parts, max = 4) {
  const out = [];
  for (const p of parts) {
    const v = text(p, 80);
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= max) break;
  }
  return out.join(', ');
}

/** Bundled place results -> Places ("London, United Kingdom" -> London / United Kingdom). */
export function offlinePlaces(results) {
  return (results ?? []).map((p) => {
    const [name, ...rest] = String(p.name).split(', ');
    return {
      id: `place:${p.name}`,
      name,
      detail: rest.join(', '),
      lat: p.latitude,
      lon: p.longitude,
      kind: 'city',
    };
  });
}

/** Photon GeoJSON -> Places: the name (or street and number), then where it is. */
export function photonPlaces(json) {
  const out = [];
  for (const f of Array.isArray(json?.features) ? json.features : []) {
    if (f?.geometry?.type !== 'Point') continue;
    const [lon, lat] = (f.geometry.coordinates ?? []).map(Number);
    if (!onGlobe(lat, lon)) continue;
    const p = f.properties ?? {};
    const street = [p.street, p.housenumber]
      .map((x) => text(x))
      .filter(Boolean)
      .join(' ');
    const name = text(p.name) || street;
    if (!name) continue;
    const detail = uniqueJoin([
      p.name ? street : '',
      p.locality ?? p.district,
      p.city,
      p.state,
      p.country,
    ]);
    const osm = p.osm_type && p.osm_id ? `${p.osm_type}${p.osm_id}` : `${lat},${lon}`;
    out.push({
      id: `osm:${osm}`,
      name,
      detail: detail === name ? '' : detail,
      lat,
      lon,
      kind:
        p.osm_key && p.osm_value ? `${p.osm_key}=${p.osm_value}`.slice(0, 60) : 'place',
    });
  }
  return out;
}

/** Proxy request for a TomTom fuzzy search (the proxy adds the key). */
export function tomtomSearchRequest(query, near = null, limit = 8) {
  const q = text(query, SEARCH_QUERY_MAX);
  const params = {
    limit: Math.min(10, Math.max(1, Math.round(Number(limit) || 8))),
    typeahead: 'true',
    language: 'en-GB',
  };
  if (near && onGlobe(Number(near.lat), Number(near.lon))) {
    params.lat = Number(Number(near.lat).toFixed(3));
    params.lon = Number(Number(near.lon).toFixed(3));
  }
  return {
    feed: TOMTOM_SEARCH_FEED,
    path: `/search/${encodeURIComponent(q)}.json`,
    params,
  };
}

/**
 * TomTom search answer -> Places. A place with a mapped entrance routes to
 * the entrance (where a car can stop), else to its position.
 */
export function tomtomPlaces(json) {
  const out = [];
  for (const r of Array.isArray(json?.results) ? json.results : []) {
    const entry =
      (r?.entryPoints ?? []).find((e) => e?.type === 'main') ?? r?.entryPoints?.[0];
    const pos = entry?.position ?? r?.position;
    const lat = Number(pos?.lat);
    const lon = Number(pos?.lon);
    if (!onGlobe(lat, lon)) continue;
    const a = r.address ?? {};
    const poi = text(r.poi?.name);
    const street = uniqueJoin(
      [[a.streetName, a.streetNumber].filter(Boolean).join(' ')],
      1,
    );
    const name = poi || text(a.freeformAddress) || street;
    if (!name) continue;
    const detail = poi
      ? text(a.freeformAddress, 120)
      : uniqueJoin([a.municipality, a.countrySubdivision, a.country]);
    const cat = Array.isArray(r.poi?.categories) ? text(r.poi.categories[0], 40) : '';
    out.push({
      id: `tomtom:${text(r.id, 80) || `${lat},${lon}`}`,
      name,
      detail: detail === name ? '' : detail,
      lat,
      lon,
      kind: cat || text(r.type, 40).toLowerCase() || 'place',
    });
  }
  return out;
}

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Merge result lists: exact offline names first, then the network lists
 * interleaved (TomTom, Photon, ...), then the other offline names. The same
 * name within 150 m of one already kept is dropped.
 */
export function mergePlaces(offline, networkLists, limit = 8) {
  const exact = offline.filter((p) => p.exact);
  const rest = offline.filter((p) => !p.exact);
  const inter = [];
  const longest = Math.max(0, ...networkLists.map((l) => l.length));
  for (let i = 0; i < longest; i += 1)
    for (const l of networkLists) if (l[i]) inter.push(l[i]);
  const out = [];
  for (const p of [...exact, ...inter, ...rest]) {
    const dup = out.some(
      (q) =>
        norm(q.name) === norm(p.name) && haversineM(q.lat, q.lon, p.lat, p.lon) < 150,
    );
    if (!dup) out.push(p);
    if (out.length >= limit) break;
  }
  return out.map(({ exact: _e, ...p }) => p);
}

/**
 * The search the navigator runs. Offline places answer even with no proxy;
 * Photon and TomTom (when keyed) are asked together, and one failing does not
 * hide the other's answer. Throws only when everything failed and nothing
 * offline matched.
 * @param {{ getJson: Function } | null} proxyClient
 * @param {string} query
 * @param {{ near?: {lat:number, lon:number}|null, limit?: number, tomtom?: boolean,
 *   signal?: AbortSignal }} [opts]
 */
export async function searchDestinations(
  proxyClient,
  query,
  { near = null, limit = 8, tomtom = false, signal } = {},
) {
  const q = text(query, SEARCH_QUERY_MAX);
  if (!q) return [];
  const found = searchPlaces(q, { limit: 3 });
  const offline = offlinePlaces(found).map((p, i) => ({ ...p, exact: found[i].exact }));
  if (!proxyClient || q.length < 3) return mergePlaces(offline, [], limit);
  const asks = [];
  if (tomtom) {
    const r = tomtomSearchRequest(q, near, limit);
    asks.push(
      proxyClient
        .getJson(r.feed, r.path, { params: r.params, signal })
        .then(tomtomPlaces),
    );
  }
  asks.push(
    proxyClient
      .getJson(PHOTON_FEED, PHOTON_PATH, { params: photonParams(q, near, limit), signal })
      .then(photonPlaces),
  );
  const settled = await Promise.allSettled(asks);
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const lists = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failure = settled.find((s) => s.status === 'rejected')?.reason;
  const merged = mergePlaces(offline, lists, limit);
  if (!merged.length && failure && !lists.some((l) => l.length)) throw failure;
  return merged;
}

/**
 * A name for a dropped pin, from OSM Nominatim's reverse geocoder through the
 * proxy: "1500 Folsom Street, San Francisco". Null when nothing answers.
 */
export async function reverseName(proxyClient, lat, lon, { signal } = {}) {
  if (!proxyClient || !onGlobe(lat, lon)) return null;
  try {
    const j = await proxyClient.getJson('nominatim', '/reverse', {
      params: {
        lat: Number(lat.toFixed(5)),
        lon: Number(lon.toFixed(5)),
        format: 'jsonv2',
        zoom: 18,
      },
      signal,
    });
    const a = j?.address ?? {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const name = text(j?.name) || street || text(j?.display_name).split(',')[0];
    const where = uniqueJoin([a.city ?? a.town ?? a.village ?? a.suburb, a.country], 2);
    return name ? { name, detail: where } : null;
  } catch {
    return null;
  }
}
