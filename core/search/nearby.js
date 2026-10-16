// A kind of place rather than a name: "gas station", "coffee", "parking near
// me", "EV charging". Photon matches names, so a station called Chevron never
// answers "gas"; a kind is looked up around the user in OpenStreetMap instead,
// nearest first: in the basemap's own vector tiles first (their poi layer,
// read by ./roadTiles.js, which the map has usually loaded already), then,
// when the tiles cannot be read or hold none within a few km, Overpass
// through the proxy's 'overpass' feed (slow on the public servers).
// The words people add when they ask out loud ("find the nearest ...",
// "... nearby", "... near me") are dropped first, from every search. Pure
// apart from the injected proxy client; places, never people.

import { haversineM } from '../nav/geo.js';

/** How long the nearby lookup may take before the search answers without it. */
export const NEARBY_TIMEOUT_MS = 9000;

// Each kind: what people say (lower case, singular and plural), the label
// for a place that has no name, the OpenStreetMap tags (Overpass), how far
// Overpass looks (dense kinds close by, sparse ones wider), and the tiles'
// poi subclasses (the same OSM values).
const KINDS = [
  {
    id: 'fuel',
    say: [
      'gas',
      'gas station',
      'gas stations',
      'petrol',
      'petrol station',
      'petrol stations',
      'fuel',
      'fuel station',
      'fuel stations',
      'filling station',
      'filling stations',
      'service station',
      'service stations',
      'diesel',
    ],
    label: 'Gas station',
    tags: [['amenity', 'fuel']],
    radiusM: 10_000,
    sub: ['fuel'],
  },
  {
    id: 'charging',
    say: [
      'ev charging',
      'ev charger',
      'ev chargers',
      'ev charging station',
      'ev charging stations',
      'charging station',
      'charging stations',
      'charger',
      'chargers',
      'electric vehicle charging',
      'supercharger',
      'superchargers',
      'ev station',
      'ev stations',
    ],
    label: 'EV charging',
    tags: [['amenity', 'charging_station']],
    radiusM: 15_000,
    sub: ['charging_station'],
  },
  {
    id: 'cafe',
    say: ['coffee', 'coffee shop', 'coffee shops', 'cafe', 'cafes', 'café', 'cafés'],
    label: 'Cafe',
    tags: [['amenity', 'cafe']],
    radiusM: 6000,
    sub: ['cafe'],
  },
  {
    id: 'food',
    say: [
      'food',
      'restaurant',
      'restaurants',
      'place to eat',
      'places to eat',
      'something to eat',
    ],
    label: 'Restaurant',
    tags: [
      ['amenity', 'restaurant'],
      ['amenity', 'fast_food'],
    ],
    radiusM: 5000,
    sub: ['restaurant', 'fast_food'],
  },
  {
    id: 'fast_food',
    say: ['fast food', 'drive thru', 'drive through', 'drive-thru'],
    label: 'Fast food',
    tags: [['amenity', 'fast_food']],
    radiusM: 6000,
    sub: ['fast_food'],
  },
  {
    id: 'parking',
    say: [
      'parking',
      'parking lot',
      'parking lots',
      'parking garage',
      'parking garages',
      'car park',
      'car parks',
      'parking structure',
    ],
    label: 'Parking',
    tags: [['amenity', 'parking']],
    radiusM: 2500,
    sub: ['parking'],
  },
  {
    id: 'hospital',
    say: ['hospital', 'hospitals', 'emergency room', 'emergency rooms'],
    label: 'Hospital',
    tags: [['amenity', 'hospital']],
    radiusM: 30_000,
    sub: ['hospital'],
  },
  {
    id: 'urgent_care',
    say: ['urgent care', 'clinic', 'clinics'],
    label: 'Clinic',
    tags: [
      ['amenity', 'clinic'],
      ['healthcare', 'urgent_care'],
    ],
    radiusM: 15_000,
    sub: ['clinic', 'doctors'],
  },
  {
    id: 'pharmacy',
    say: ['pharmacy', 'pharmacies', 'drugstore', 'drugstores', 'drug store', 'chemist'],
    label: 'Pharmacy',
    tags: [['amenity', 'pharmacy']],
    radiusM: 10_000,
    sub: ['pharmacy', 'chemist'],
  },
  {
    id: 'atm',
    say: ['atm', 'atms', 'cash machine', 'cash machines'],
    label: 'ATM',
    tags: [['amenity', 'atm']],
    radiusM: 5000,
    sub: ['atm'],
  },
  {
    id: 'bank',
    say: ['bank', 'banks'],
    label: 'Bank',
    tags: [['amenity', 'bank']],
    radiusM: 8000,
    sub: ['bank'],
  },
  {
    id: 'grocery',
    say: [
      'grocery',
      'groceries',
      'grocery store',
      'grocery stores',
      'supermarket',
      'supermarkets',
    ],
    label: 'Supermarket',
    tags: [['shop', 'supermarket']],
    radiusM: 10_000,
    sub: ['supermarket'],
  },
  {
    id: 'convenience',
    say: ['convenience store', 'convenience stores', 'corner store'],
    label: 'Convenience store',
    tags: [['shop', 'convenience']],
    radiusM: 5000,
    sub: ['convenience'],
  },
  {
    id: 'toilets',
    say: [
      'restroom',
      'restrooms',
      'toilet',
      'toilets',
      'bathroom',
      'bathrooms',
      'public restroom',
      'public toilet',
    ],
    label: 'Restroom',
    tags: [['amenity', 'toilets']],
    radiusM: 6000,
    sub: ['toilets'],
  },
  {
    id: 'lodging',
    say: ['hotel', 'hotels', 'motel', 'motels', 'lodging', 'place to stay'],
    label: 'Hotel',
    tags: [
      ['tourism', 'hotel'],
      ['tourism', 'motel'],
    ],
    radiusM: 15_000,
    sub: ['hotel', 'motel'],
  },
  {
    id: 'rest_area',
    say: [
      'rest area',
      'rest areas',
      'rest stop',
      'rest stops',
      'truck stop',
      'truck stops',
    ],
    label: 'Rest area',
    tags: [
      ['highway', 'rest_area'],
      ['highway', 'services'],
    ],
    radiusM: 60_000,
    sub: ['rest_area', 'services'],
  },
  {
    id: 'car_wash',
    say: ['car wash', 'car washes'],
    label: 'Car wash',
    tags: [['amenity', 'car_wash']],
    radiusM: 10_000,
    sub: ['car_wash'],
  },
  {
    id: 'repair',
    say: [
      'mechanic',
      'mechanics',
      'auto repair',
      'car repair',
      'tire shop',
      'tire shops',
      'tyre shop',
    ],
    label: 'Auto repair',
    tags: [
      ['shop', 'car_repair'],
      ['shop', 'tyres'],
    ],
    radiusM: 10_000,
    sub: ['car_repair', 'tyres'],
  },
  {
    id: 'police',
    say: ['police station', 'police stations'],
    label: 'Police station',
    tags: [['amenity', 'police']],
    radiusM: 20_000,
    sub: ['police'],
  },
  {
    id: 'post',
    say: ['post office', 'post offices'],
    label: 'Post office',
    tags: [['amenity', 'post_office']],
    radiusM: 10_000,
    sub: ['post_office'],
  },
  {
    id: 'bar',
    say: ['bar', 'bars', 'pub', 'pubs'],
    label: 'Bar',
    tags: [
      ['amenity', 'bar'],
      ['amenity', 'pub'],
    ],
    radiusM: 5000,
    sub: ['bar', 'pub'],
  },
];

const BY_PHRASE = new Map();
for (const k of KINDS) for (const s of k.say) BY_PHRASE.set(s, k);

// Leading: a verb ("find", "show me", "take me to"), then "the nearest" and
// the like. An article alone stays (a name such as "The Home Depot").
const LEAD =
  /^(?:please\s+)?(?:(?:find|show(?:\s+me)?|search(?:\s+for)?|look(?:\s+for)?|get(?:\s+me)?|take\s+me\s+to|go\s+to|where(?:'s|\s+is)|i\s+need)\s+)?(?:(?:a|an|the|some|any)\s+(?=(?:nearest|closest|nearby|local)\s))?(?:(?:nearest|closest|nearby|local)\s+)?/i;
const TRAIL =
  /\s*(?:near(?:\s+me|\s+here|\s+by)?|nearby|around(?:\s+here|\s+me)?|close\s*by|close\s+to\s+me|in\s+the\s+area|on\s+my\s+way|on\s+the\s+way|along\s+the\s+way)\s*$/i;

/**
 * The words around what was asked for, dropped: "find the nearest gas
 * stations near me" -> "gas stations". The middle is kept as it is; a query
 * that is nothing but such words is kept unchanged.
 */
export function stripFiller(query) {
  const q = String(query ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const out = q.replace(TRAIL, '').replace(LEAD, '').replace(TRAIL, '').trim();
  return out.length >= 2 ? out : q;
}

/** The kind of place a query asks for, or null (a name, an address). */
export function nearbyKind(query) {
  const q = stripFiller(query)
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/^(?:a|an|the|some|any)\s+/, '')
    .trim();
  return BY_PHRASE.get(q) ?? null;
}

/** Overpass QL: places of `kind` within its radius of `near`, with their centres. */
export function overpassNearbyQuery(kind, near, radiusM = kind.radiusM) {
  const around = `(around:${Math.round(radiusM)},${near.lat.toFixed(5)},${near.lon.toFixed(5)})`;
  const sel = kind.tags.map(([k, v]) => `nwr["${k}"="${v}"]${around};`).join('');
  return `[out:json][timeout:15];(${sel});out center 80;`;
}

const tagText = (v, max = 80) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** Overpass elements -> Places, nearest `near` first. */
export function parseNearby(json, kind, near, limit = 8) {
  const seen = new Set();
  const out = [];
  for (const e of Array.isArray(json?.elements) ? json.elements : []) {
    const lat = Number(e?.lat ?? e?.center?.lat);
    const lon = Number(e?.lon ?? e?.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${e.type}/${e.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = e.tags ?? {};
    const name = tagText(t.name) || tagText(t.brand) || tagText(t.operator) || kind.label;
    const street = [tagText(t['addr:housenumber'], 12), tagText(t['addr:street'])]
      .filter(Boolean)
      .join(' ');
    const detail = [street, tagText(t['addr:city'])].filter(Boolean).join(', ');
    out.push({
      id: `osm:${key}`,
      name,
      detail: detail || kind.label,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      kind: kind.id,
      distM: haversineM(near.lat, near.lon, lat, lon),
    });
  }
  return out
    .sort((a, b) => a.distM - b.distM)
    .slice(0, limit)
    .map(({ distM: _d, ...p }) => p);
}

/** The tiles' places (./roadTiles.js pois) of `kind` -> Places, nearest `near` first. */
export function tileNearby(pois, kind, near, limit = 8, maxM = kind.radiusM) {
  const want = new Set(kind.sub);
  const out = [];
  const seen = new Set();
  for (const p of pois || []) {
    if (!want.has(p.sub)) continue;
    const d = haversineM(near.lat, near.lon, p.lat, p.lon);
    if (!(d <= maxM)) continue;
    const key = `${p.name}|${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    if (seen.has(key)) continue; // a place on a tile edge comes twice
    seen.add(key);
    out.push({
      id: `tile:${p.sub}:${p.lat.toFixed(5)},${p.lon.toFixed(5)}`,
      name: p.name || kind.label,
      detail: kind.label,
      lat: p.lat,
      lon: p.lon,
      kind: kind.id,
      distM: d,
    });
  }
  return out
    .sort((a, b) => a.distM - b.distM)
    .slice(0, limit)
    .map(({ distM: _d, ...p }) => p);
}

/** How many places of a kind are enough to stop widening the tile search. */
const ENOUGH = 5;

/**
 * Places of `kind` around `near`, nearest first: the tiles around it ring by
 * ring (about 3, 5 and 7 km out) until ENOUGH, else Overpass (for at most
 * `overpassMs`). Never throws ([] when nothing answers).
 * @param {{ proxyClient?: object|null, roads?: Function|null, kind: object,
 *   near: {lat:number, lon:number}, limit?: number, signal?: AbortSignal,
 *   overpassMs?: number }} opts
 */
export async function findNearby({
  proxyClient = null,
  roads = null,
  kind,
  near,
  limit = 8,
  signal,
  overpassMs = NEARBY_TIMEOUT_MS,
}) {
  if (!kind || !near) return [];
  let fromTiles = [];
  if (roads?.pois) {
    for (const ring of [1, 2, 3]) {
      try {
        fromTiles = tileNearby(await roads.pois(near, ring, signal), kind, near, limit);
      } catch {
        if (signal?.aborted) return [];
        break; // the tiles cannot be read: Overpass
      }
      if (fromTiles.length >= Math.min(ENOUGH, limit)) return fromTiles;
    }
  }
  // Overpass, for as long as the search can wait: the tiles' few, else none.
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), overpassMs);
  });
  const far = await Promise.race([
    lookupNearby(proxyClient, kind, near, { limit, signal }).catch(() => null),
    late,
  ]).finally(() => clearTimeout(timer));
  return far?.length ? far : fromTiles;
}

/** Places of `kind` around `near`, nearest first (Overpass through the proxy). */
export async function lookupNearby(proxyClient, kind, near, { limit = 8, signal } = {}) {
  if (!proxyClient || !kind || !near) return [];
  const json = await proxyClient.getJson('overpass', '/interpreter', {
    params: { data: overpassNearbyQuery(kind, near) },
    signal,
  });
  return parseNearby(json, kind, near, limit);
}
