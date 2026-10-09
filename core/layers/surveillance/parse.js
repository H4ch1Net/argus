// The surveillance layer's Overpass query and parser. Pure: shared by the globe
// and the terminal.
//
// One query per tile (core/layers/overpass/tiles.js) asks for every mapped
// surveillance device (man_made=surveillance, nodes and ways), every speed
// camera node (highway=speed_camera), and the enforcement relations
// (type=enforcement) with their "device" member nodes, so a red-light or
// average-speed camera mapped only through its relation is still found, and
// one mapped as a bare road node still gets its kind. Device nodes that are
// also speed cameras come back twice; the first copy wins.
//
// GUARDRAIL: locations and mapped attributes only (where a device is, which way
// it is mapped as facing, who operates it). Nothing reads what it sees.

import { bboxText } from '../overpass/tiles.js';
import { surveillanceKindOf, ENFORCEMENT_KINDS } from './kinds.js';

/** The tile grid (degrees) and how long a tile is kept (fetched once, then held). */
export const SURVEILLANCE_TILE_DEG = 0.1;
export const SURVEILLANCE_TTL_MS = 12 * 60 * 60 * 1000;
/** Elements per tile: central Paris holds about 4,800 per 0.1 degree tile. */
export const SURVEILLANCE_TILE_CAP = 6000;
const DEVICE_CAP = 500;

/** Overpass QL for one tile. */
export function surveillanceQuery(bbox) {
  const b = bboxText(bbox);
  return (
    `[out:json][timeout:25];` +
    `(node["man_made"="surveillance"](${b});way["man_made"="surveillance"](${b});` +
    `node["highway"="speed_camera"](${b}););out center ${SURVEILLANCE_TILE_CAP};` +
    `rel["type"="enforcement"](${b})->.r;node(r.r:"device");out ${DEVICE_CAP};` +
    `.r out body ${DEVICE_CAP};`
  );
}

const DEVICE_TAGS = (t) => t.man_made === 'surveillance' || t.highway === 'speed_camera';

/**
 * Overpass JSON -> normalized records:
 * { id: 'node/1', type: 'surveillance', position, meta: { tags, kind, osmType,
 *   osmId, enforcement?: { id, kind, name, maxspeed } } }.
 */
export function parseSurveillance(json) {
  const elements = Array.isArray(json?.elements) ? json.elements : [];
  // device node id -> its enforcement relation
  const devices = new Map();
  for (const e of elements) {
    if (e?.type !== 'relation' || e.tags?.type !== 'enforcement') continue;
    for (const m of e.members || []) {
      if (m.type === 'node' && m.role === 'device' && !devices.has(m.ref))
        devices.set(m.ref, e);
    }
  }
  const out = [];
  const seen = new Set();
  for (const e of elements) {
    if (!e || e.type === 'relation') continue;
    const lat = typeof e.lat === 'number' ? e.lat : e.center?.lat;
    const lon = typeof e.lon === 'number' ? e.lon : e.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const tags = e.tags || {};
    const rel = e.type === 'node' ? devices.get(e.id) : undefined;
    const enforcement = rel
      ? {
          id: rel.id,
          kind: String(rel.tags.enforcement || ''),
          name: rel.tags.name ? String(rel.tags.name) : null,
          maxspeed: rel.tags.maxspeed ? String(rel.tags.maxspeed) : null,
        }
      : null;
    // The relation says what the device enforces (it wins over a node's own,
    // sometimes stray, enforcement tag: Paris has red-light devices tagged
    // enforcement=check on the node).
    const kind = surveillanceKindOf(
      enforcement?.kind ? { ...tags, enforcement: enforcement.kind } : tags,
    );
    // A relation's device that is a plain road node (a police check, an
    // access rule) and no camera kind: not something this layer maps.
    if (enforcement && !DEVICE_TAGS(tags) && !ENFORCEMENT_KINDS.has(kind)) continue;
    out.push({
      id,
      type: 'surveillance',
      position: { longitude: lon, latitude: lat, altitude: 0 },
      meta: { tags, kind, osmType: e.type, osmId: e.id, enforcement },
    });
  }
  return out;
}

/** A tiled pass ({ items }) or raw Overpass JSON (the dev mock) -> records. */
export function normalizeSurveillance(raw) {
  return Array.isArray(raw?.items) ? raw.items : parseSurveillance(raw);
}
