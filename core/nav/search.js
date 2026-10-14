// Destination search for navigation: the user's saved places (HOME, WORK,
// SAVED: core/places/saved.js), the bundled offline places, Photon (komoot,
// OSM data) through the proxy, TomTom fuzzy search when the proxy holds a
// TomTom key, for a numbered street address the address geocoders
// (../search/address.js: US Census, else Nominatim), and for "A & B" the
// crossing of two streets (../search/intersection.js: the basemap's vector
// tiles, else Overpass), all biased near the user (or the view centre) and
// ranked local first (../search/rank.js), merged into Places: { id, name,
// detail, lat, lon, kind }. The query SAVED_QUERY ("@saved") answers HOME,
// WORK, the saved places and the recent destinations (the car's WHERE TO
// asks it before anything is typed). Pure apart from the injected proxy
// client and stores: every shell shares it. Inputs are places and addresses,
// never people.
//
// TomTom Search (search/2/search, feed 'tomtom-search') is per the provider's
// documentation, not live-tested here (no key in this environment). Photon's
// parser is tested against a real answer (test/fixtures/photon.json).

import { searchPlaces } from '../search/places.js';
import { PHOTON_FEED, PHOTON_PATH, photonParams } from '../search/photon.js';
import { lookupAddress, parseAddress } from '../search/address.js';
import { rankPlaces, textScore } from '../search/rank.js';
import {
  parseIntersection,
  lookupIntersection,
  crossingPlace,
} from '../search/intersection.js';
import { reversePlace } from '../search/reverse.js';
import { haversineM } from './geo.js';

/** The query that lists HOME, WORK, the saved places and the recent ones. */
export const SAVED_QUERY = '@saved';
/** An intersection that takes longer than this is left out of the answer. */
export const INTERSECTION_TIMEOUT_MS = 9000;
/** How long the town of a crossing may take (Photon reverse) before it is left out. */
const TOWN_TIMEOUT_MS = 1500;
/** With a crossing in hand, how long the place search may still take. */
const CROSSING_GRACE_MS = 1200;

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

// Countries whose addresses put the house number before the street.
const NUMBER_FIRST = new Set(['US', 'CA', 'GB', 'IE', 'AU', 'NZ', 'FR']);

/** Photon GeoJSON -> Places: the name (or street and number), then where it is. */
export function photonPlaces(json) {
  const out = [];
  for (const f of Array.isArray(json?.features) ? json.features : []) {
    if (f?.geometry?.type !== 'Point') continue;
    const [lon, lat] = (f.geometry.coordinates ?? []).map(Number);
    if (!onGlobe(lat, lon)) continue;
    const p = f.properties ?? {};
    // "83053 Avenue 48" where addresses lead with the number; "Rue X 10" else.
    const numberFirst = NUMBER_FIRST.has(String(p.countrycode ?? '').toUpperCase());
    const street = (numberFirst ? [p.housenumber, p.street] : [p.street, p.housenumber])
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
 * Merge result lists: the user's own saved places that match first, then
 * exact offline names, then the network lists (TomTom, Photon, addresses)
 * interleaved and, given the query, ranked local first (../search/rank.js:
 * text match less distance from `near`), then the other offline names.
 * Street crossings (`crossings`) lead when the query clearly names two
 * streets (`strongCross`); else (a name with "and" in it) they follow the
 * network results when one of those matches the query well, and lead when
 * none does. The same name within 150 m of one already kept is dropped.
 */
export function mergePlaces(
  offline,
  networkLists,
  limit = 8,
  { query = '', near = null, mine = [], crossings = [], strongCross = false } = {},
) {
  const exact = offline.filter((p) => p.exact);
  const rest = offline.filter((p) => !p.exact);
  let inter = [];
  const longest = Math.max(0, ...networkLists.map((l) => l.length));
  for (let i = 0; i < longest; i += 1)
    for (const l of networkLists) if (l[i]) inter.push(l[i]);
  if (query) inter = rankPlaces(query, inter, { near });
  let ordered;
  if (strongCross || !crossings.length)
    ordered = [...mine, ...crossings, ...exact, ...inter, ...rest];
  else {
    const good = [...exact, ...inter].some(
      (p) => textScore(query, p.name, p.detail ?? '') >= 0.75,
    );
    ordered = good
      ? [...mine, ...exact, ...inter, ...crossings, ...rest]
      : [...mine, ...crossings, ...exact, ...inter, ...rest];
  }
  const out = [];
  for (const p of ordered) {
    const dup = out.some(
      (q) =>
        norm(q.name) === norm(p.name) && haversineM(q.lat, q.lon, p.lat, p.lon) < 150,
    );
    if (!dup) out.push(p);
    if (out.length >= limit) break;
  }
  return out.map(({ exact: _e, number: _n, ...p }) => p);
}

const ROLE_NAMES = { home: 'Home', work: 'Work' };

/**
 * A saved place (core/places/saved.js) as a search Place: HOME and WORK by
 * their role ("Home", with the place's own name as the detail unless that
 * only repeats the role), the others by name. `savedId` is the saved record's
 * id.
 */
export function savedPlace(p) {
  const role = ROLE_NAMES[p.kind] ? p.kind : null;
  const own = String(p.name ?? '');
  const repeats = role && own.trim().toLowerCase() === role;
  return {
    id: `saved:${p.id}`,
    name: role ? ROLE_NAMES[role] : p.name,
    detail: role && !repeats ? own : (p.note ?? ''),
    lat: p.lat,
    lon: p.lon,
    kind: role ?? 'saved',
    savedId: p.id,
  };
}

/**
 * What WHERE TO shows before anything is typed: HOME, WORK, the other saved
 * places (nearest `near` first), then the recent destinations that are not
 * saved places (kind 'recent').
 * @param {{ places?: object|null, recents?: object|null,
 *   near?: {lat:number, lon:number}|null, savedMax?: number, recentMax?: number }} [opts]
 */
export function savedShortlist({
  places = null,
  recents = null,
  near = null,
  savedMax = 8,
  recentMax = 5,
} = {}) {
  places?.refresh?.();
  const all = places?.list?.() ?? [];
  const here = near && onGlobe(Number(near.lat), Number(near.lon)) ? near : null;
  const far = (p) => (here ? haversineM(here.lat, here.lon, p.lat, p.lon) : 0);
  const roles = ['home', 'work']
    .map((k) => all.find((p) => p.kind === k))
    .filter(Boolean);
  const others = all
    .filter((p) => p.kind !== 'home' && p.kind !== 'work')
    .map((p, i) => ({ p, i, d: far(p) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .slice(0, savedMax)
    .map((x) => x.p);
  const out = [...roles, ...others].map(savedPlace);
  let n = 0;
  for (const r of recents?.list?.() ?? []) {
    if (n >= recentMax) break;
    if (all.some((p) => haversineM(p.lat, p.lon, r.lat, r.lon) < 50)) continue;
    out.push({
      id: `recent:${r.id}`,
      name: r.name,
      detail: r.detail ?? '',
      lat: r.lat,
      lon: r.lon,
      kind: 'recent',
    });
    n += 1;
  }
  return out;
}

/** Promise.allSettled that can also say what has settled so far. */
function settleSoFar(promises) {
  const out = promises.map(() => null);
  const done = Promise.all(
    promises.map((p, i) =>
      p.then(
        (value) => (out[i] = { status: 'fulfilled', value }),
        (reason) => (out[i] = { status: 'rejected', reason }),
      ),
    ),
  ).then(() => out);
  return { done, now: () => out.filter(Boolean) };
}

/** A promise's answer, or `fallback` once `ms` have passed. */
function withTimeout(promise, ms, fallback) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * The crossings of an intersection query as Places, each with the town it
 * is in (Photon reverse at the crossing). Never throws: [] on any failure.
 */
async function crossingPlaces(parsed, { proxyClient, roads, near, signal }) {
  try {
    const found = await lookupIntersection(parsed, {
      near,
      loadRoads: roads,
      proxyClient,
      signal,
    });
    return await Promise.all(
      found.slice(0, 2).map(async (c) => {
        // The town is a nicety: a slow reverse geocoder never holds the crossing back.
        const r = await withTimeout(
          reversePlace(proxyClient, c.lat, c.lon, { decimals: 4 }),
          TOWN_TIMEOUT_MS,
          null,
        );
        return crossingPlace(c, r ? [r.city, r.state].filter(Boolean).join(', ') : '');
      }),
    );
  } catch {
    return [];
  }
}

/**
 * The search the navigator runs. Offline places answer even with no proxy;
 * Photon and TomTom (when keyed) are asked together, and one failing does not
 * hide the other's answer. Throws only when everything failed and nothing
 * offline matched.
 * @param {{ getJson: Function } | null} proxyClient
 * @param {string} query
 * @param {{ near?: {lat:number, lon:number}|null, limit?: number, tomtom?: boolean,
 *   signal?: AbortSignal, places?: object|null, recents?: object|null,
 *   roads?: Function|null }} [opts]
 *   places: the saved places store; recents: the recent destinations;
 *   roads: the road line loader for intersections (../search/roadTiles.js)
 */
export async function searchDestinations(
  proxyClient,
  query,
  {
    near = null,
    limit = 8,
    tomtom = false,
    signal,
    places = null,
    recents = null,
    roads = null,
  } = {},
) {
  const q = text(query, SEARCH_QUERY_MAX);
  if (!q) return [];
  const here =
    near && onGlobe(Number(near.lat), Number(near.lon))
      ? { lat: Number(near.lat), lon: Number(near.lon) }
      : null;
  if (q.toLowerCase() === SAVED_QUERY)
    return savedShortlist({ places, recents, near: here, savedMax: limit });
  places?.refresh?.();
  const mine = (places?.search?.(q, 3) ?? []).map(savedPlace);
  const found = searchPlaces(q, { limit: 3 });
  const offline = offlinePlaces(found).map((p, i) => ({ ...p, exact: found[i].exact }));
  if (!proxyClient || q.length < 3) return mergePlaces(offline, [], limit, { mine });
  const asks = [];
  // A house number first: the address geocoders too (Census in the US, else
  // Nominatim around the user); Photon often has the street but not the number.
  if (parseAddress(q)) asks.push(lookupAddress(proxyClient, q, { near: here, signal }));
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
  // Two streets: where they cross near the user, beside the place search.
  const inter = here ? parseIntersection(q) : null;
  const crossing = inter
    ? withTimeout(
        crossingPlaces(inter, { proxyClient, roads, near: here, signal }),
        INTERSECTION_TIMEOUT_MS,
        [],
      )
    : Promise.resolve([]);
  const all = settleSoFar(asks);
  const crossings = await crossing;
  // A clear intersection that was found does not wait long for a slow place
  // search (Photon answering 502 after 15 s, Oct 2026): what came is enough.
  const settled =
    inter?.strong && crossings.length
      ? ((await withTimeout(all.done, CROSSING_GRACE_MS, null)) ?? all.now())
      : await all.done;
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  const lists = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failure = settled.find((s) => s.status === 'rejected')?.reason;
  const merged = mergePlaces(offline, lists, limit, {
    query: q,
    near: here,
    mine,
    crossings,
    strongCross: Boolean(inter?.strong),
  });
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
