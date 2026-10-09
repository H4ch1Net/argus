// Landmarks from OpenStreetMap around the view: the Overpass query, the parser,
// ranking for the NEARBY list, and how to frame one when flying to it. Pure (no
// Cesium, no DOM): the globe's layer, TOOLS > LANDMARKS and the terminal share
// it, and it replaces the old hand-picked list of a few cities.
//
// What counts (named only): tourism=attraction|museum|viewpoint|zoo|theme_park|
// aquarium; historic=monument|castle|memorial|monastery|fort|palace|city_gate|
// ruins|archaeological_site|tower (not the thousands of small memorial plaques
// and Stolpersteine); man_made=tower|lighthouse (communication and cooling
// towers only when they have a Wikipedia / Wikidata entry). Things with a
// Wikipedia or Wikidata link rank first.

import {
  bboxText,
  createTileLoader,
  createTiledSource,
  overpassFetcher,
} from '../overpass/tiles.js';

export const LANDMARKS_TILE_DEG = 0.1;
export const LANDMARKS_TTL_MS = 24 * 60 * 60 * 1000;
export const LANDMARKS_MAX_TILES = 40;
export const LANDMARKS_VIEW_TILES = 9;
export const LANDMARKS_MAX_VIEW_KM = 45;
const TILE_CAP = 1500;

const TOURISM = 'attraction|museum|viewpoint|zoo|theme_park|aquarium';
const HISTORIC =
  'monument|castle|memorial|monastery|fort|palace|city_gate|ruins|archaeological_site|tower';
const SMALL_MEMORIALS = 'plaque|blue_plaque|stolperstein|ghost_bike|board|bench|tree';

/** Overpass QL for one tile (tags and a centre only: no way geometry). */
export function landmarksQuery(bbox) {
  const b = bboxText(bbox);
  return (
    `[out:json][timeout:25];(` +
    `nwr["tourism"~"^(${TOURISM})$"]["name"](${b});` +
    `nwr["historic"~"^(${HISTORIC})$"]["name"]["memorial"!~"^(${SMALL_MEMORIALS})$"](${b});` +
    `nwr["man_made"~"^(tower|lighthouse)$"]["name"](${b});` +
    `);out tags center ${TILE_CAP};`
  );
}

/** True when the landmark links to Wikipedia or Wikidata. */
export const isNotable = (tags) => Boolean(tags?.wikidata || tags?.wikipedia);

/** The landmark's category id: tower, museum, castle, viewpoint, ... */
export function landmarkCategory(tags = {}) {
  if (tags.man_made === 'lighthouse') return 'lighthouse';
  if (tags.man_made === 'tower' || tags.historic === 'tower') return 'tower';
  if (tags.tourism && tags.tourism !== 'attraction') return tags.tourism;
  if (tags.historic) return tags.historic;
  return tags.tourism || 'feature';
}

const RE_TOURISM = new RegExp(`^(${TOURISM})$`);
const RE_HISTORIC = new RegExp(`^(${HISTORIC})$`);
const RE_SMALL = new RegExp(`^(${SMALL_MEMORIALS})$`);
const MINOR_TOWER = /^(communication|cooling|lighting|siren|bell_tower|minaret)$/;

/** The query's test, applied again to what comes back (and to the dev mock). */
export function isLandmark(tags = {}) {
  if (!tags.name) return false;
  if (RE_TOURISM.test(tags.tourism || '')) return true;
  if (RE_HISTORIC.test(tags.historic || '') && !RE_SMALL.test(tags.memorial || ''))
    return true;
  return /^(tower|lighthouse)$/.test(tags.man_made || '');
}

/**
 * Overpass JSON -> normalized records:
 * { id, type: 'landmark', position, meta: { tags, name, category, notable,
 *   osmType, osmId } }.
 */
export function parseLandmarks(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  const out = [];
  const seen = new Set();
  for (const e of elements) {
    const lat = typeof e?.lat === 'number' ? e.lat : e?.center?.lat;
    const lon = typeof e?.lon === 'number' ? e.lon : e?.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const tags = e.tags || {};
    const name = String(tags.name || '').trim();
    if (!name || !isLandmark(tags)) continue;
    const notable = isNotable(tags);
    if (
      tags.man_made === 'tower' &&
      MINOR_TOWER.test(tags['tower:type'] || '') &&
      !notable
    )
      continue;
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: 'landmark',
      position: { longitude: lon, latitude: lat, altitude: 0 },
      meta: {
        tags,
        name: name.slice(0, 80),
        category: landmarkCategory(tags),
        notable,
        osmType: e.type,
        osmId: e.id,
      },
    });
  }
  return out;
}

/** A tiled pass ({ items }) or raw Overpass JSON (the dev mock) -> records. */
export function normalizeLandmarks(raw) {
  return Array.isArray(raw?.items) ? raw.items : parseLandmarks(raw);
}

/** One loader for the landmarks layer and the NEARBY list (fetched once for both). */
export function createLandmarksLoader({ proxyClient, fetchTile }) {
  return createTileLoader({
    fetchTile: fetchTile ?? overpassFetcher(proxyClient, landmarksQuery),
    parse: parseLandmarks,
    tileDeg: LANDMARKS_TILE_DEG,
    ttlMs: LANDMARKS_TTL_MS,
    maxTiles: LANDMARKS_MAX_TILES,
  });
}

/** The landmarks layer's viewport source over a loader. */
export function createLandmarksSource(loader, { anchor, onUpdate } = {}) {
  return createTiledSource(loader, {
    maxViewKm: LANDMARKS_MAX_VIEW_KM,
    maxViewTiles: LANDMARKS_VIEW_TILES,
    anchor,
    onUpdate,
  });
}

// --- the NEARBY list ---------------------------------------------------------

const R_KM = 6371.0088;
const D2R = Math.PI / 180;

/** Great-circle distance in km. */
export function distanceKm(a, b) {
  const dLat = (b.lat - a.lat) * D2R;
  const dLon = (b.lon - a.lon) * D2R;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a, b) {
  const p1 = a.lat * D2R;
  const p2 = b.lat * D2R;
  const dl = (b.lon - a.lon) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (((Math.atan2(y, x) / D2R) % 360) + 360) % 360;
}

const foldName = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * The NEARBY list: landmarks within maxKm of `at`, Wikipedia / Wikidata ones
 * first, then by distance; one entry per name (a museum mapped as a point and
 * as its building comes once). -> [{ n, km }]
 */
export function rankLandmarks(list, at, { limit = 12, maxKm = 15 } = {}) {
  if (!at) return [];
  const cands = [];
  for (const n of list) {
    const p = n?.position;
    if (!p) continue;
    const km = distanceKm(at, { lat: p.latitude, lon: p.longitude });
    if (km <= maxKm) cands.push({ n, km });
  }
  cands.sort(
    (a, b) => Number(b.n.meta.notable) - Number(a.n.meta.notable) || a.km - b.km,
  );
  const names = new Set();
  const out = [];
  for (const c of cands) {
    const key = foldName(c.n.meta.name);
    if (names.has(key)) continue;
    names.add(key);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

// How to frame each kind: range (m) from the landmark, pitch (deg), and the
// height (m) of the point looked at (a tower is framed at its middle).
const FRAMES = {
  tower: { range: 950, pitch: -16, height: 50 },
  lighthouse: { range: 650, pitch: -18, height: 18 },
  castle: { range: 1300, pitch: -30, height: 15 },
  palace: { range: 1200, pitch: -30, height: 15 },
  fort: { range: 1300, pitch: -35, height: 8 },
  monastery: { range: 1000, pitch: -30, height: 12 },
  museum: { range: 700, pitch: -32, height: 12 },
  aquarium: { range: 700, pitch: -32, height: 8 },
  viewpoint: { range: 600, pitch: -25, height: 0 },
  zoo: { range: 2200, pitch: -45, height: 0 },
  theme_park: { range: 2200, pitch: -45, height: 0 },
  ruins: { range: 600, pitch: -35, height: 4 },
  archaeological_site: { range: 700, pitch: -45, height: 0 },
  monument: { range: 450, pitch: -26, height: 8 },
  memorial: { range: 380, pitch: -26, height: 4 },
  city_gate: { range: 450, pitch: -22, height: 10 },
};
const DEFAULT_FRAME = { range: 900, pitch: -35, height: 10 };

/**
 * The fly-to view for a landmark: { lon, lat, height, range, pitch, heading }
 * (metres, degrees). heading faces the landmark from `from` (so the flight
 * runs forwards), north when no `from` is given. A mapped height (tags.height)
 * sets the point looked at to its middle and backs the camera off to fit it.
 */
export function landmarkFraming(n, from = null) {
  const f = FRAMES[n.meta.category] ?? DEFAULT_FRAME;
  const tall = Number.parseFloat(n.meta.tags?.height);
  const h = Number.isFinite(tall) && tall > 0 && tall < 1000 ? tall : null;
  const lat = n.position.latitude;
  const lon = n.position.longitude;
  const near = from && distanceKm(from, { lat, lon }) > 0.05;
  return {
    lon,
    lat,
    height: h ? h / 2 : f.height,
    range: h ? Math.max(f.range, h * 5) : f.range,
    pitch: f.pitch,
    heading: near ? bearingDeg(from, { lat, lon }) : 0,
  };
}
