// Road lines for the intersection search (./intersection.js), read from the
// basemap's own vector tiles: OpenFreeMap (OpenMapTiles schema) through the
// proxy feeds 'openfreemap' (the TileJSON naming the current tile set) and
// 'openfreemap-tiles' (z14 tiles, the deepest it serves, about 2 km across
// at Indio's latitude). The `transportation_name` layer holds every named or
// numbered road as lines with name, name_en, ref and network; the `poi`
// layer holds the places (fuel, cafes, parking, hotels...) with their OSM
// subclass, for "gas station near me" (./nearby.js); that is all that is
// decoded. Tiles are asked nearest first, kept decoded (a few dozen,
// least recently used out), and never cancelled half way: the next keystroke
// of the same search wants the same tiles. The proxy caches them too (a
// week), and they are often there already from the DARK basemap.
//
// No Cesium and no DOM: the terminal geocoder can use it. The decoder is the
// basemap's (core/scene/vector/mvt.js, pure).

import { decodeTile } from '../scene/vector/mvt.js';

export const ROAD_ZOOM = 14;
export const TILESET_FEED = 'openfreemap';
export const TILES_FEED = 'openfreemap-tiles';
/** A dated tile set in the TileJSON's tile URL (the proxy pins the same shape). */
const TILESET = /\/planet\/(\d{8}_\d{6}_pt)\/\{z\}\/\{x\}\/\{y\}\.pbf$/;
const WANT = {
  transportation_name: ['name', 'name_en', 'ref', 'network', 'class'],
  poi: ['name', 'name_en', 'class', 'subclass'],
};

/** The z14 tile holding a point. */
export function tileOf(lat, lon, z = ROAD_ZOOM) {
  const n = 2 ** z;
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return {
    x: Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n))),
    y: Math.min(
      n - 1,
      Math.max(
        0,
        Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n),
      ),
    ),
  };
}

/** Tile x, y plus a position inside it (0..1) -> [lat, lon]. */
export function tileToLatLon(x, y, fx, fy, z = ROAD_ZOOM) {
  const n = 2 ** z;
  const lon = ((x + fx) / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + fy)) / n))) * 180) / Math.PI;
  return [lat, lon];
}

/** The tiles within `ring` of the centre, nearest first (ring 1: 3x3). */
export function tilesAround(cx, cy, ring, z = ROAD_ZOOM) {
  const n = 2 ** z;
  const out = [];
  for (let dy = -ring; dy <= ring; dy += 1)
    for (let dx = -ring; dx <= ring; dx += 1) {
      const y = cy + dy;
      if (y < 0 || y >= n) continue;
      out.push({
        x: (((cx + dx) % n) + n) % n,
        y,
        d: Math.max(Math.abs(dx), Math.abs(dy)),
      });
    }
  return out.sort((a, b) => a.d - b.d);
}

/** One decoded tile -> road lines { names, ref, network, cls, coords: [[lat, lon]...] }. */
export function roadLines(bytes, x, y, z = ROAD_ZOOM) {
  return tileContent(bytes, x, y, z).lines;
}

/**
 * One decoded tile -> { lines, pois }: the road lines (as roadLines) and
 * the places { name, cls, sub, lat, lon } (sub: the OSM value, "fuel",
 * "charging_station", "cafe"...).
 */
export function tileContent(bytes, x, y, z = ROAD_ZOOM) {
  const decoded = decodeTile(bytes, WANT);
  return {
    lines: linesOf(decoded.transportation_name, x, y, z),
    pois: poisOf(decoded.poi, x, y, z),
  };
}

function poisOf(layer, x, y, z) {
  if (!layer) return [];
  const ext = layer.extent || 4096;
  const out = [];
  for (const f of layer.features) {
    if (f.type !== 1) continue;
    const p = f.props ?? {};
    const pt = f.parts?.[0];
    if (!pt || pt.length < 2) continue;
    const [lat, lon] = tileToLatLon(x, y, pt[0] / ext, pt[1] / ext, z).map(round6);
    const name = [p.name, p.name_en].find((v) => typeof v === 'string' && v.trim()) ?? '';
    out.push({
      name: name.trim(),
      cls: typeof p.class === 'string' ? p.class : '',
      sub: typeof p.subclass === 'string' ? p.subclass : '',
      lat,
      lon,
    });
  }
  return out;
}

function linesOf(layer, x, y, z) {
  if (!layer) return [];
  const ext = layer.extent || 4096;
  const out = [];
  for (const f of layer.features) {
    if (f.type !== 2) continue;
    const p = f.props ?? {};
    const names = [p.name, p.name_en].filter((v) => typeof v === 'string' && v.trim());
    const ref = typeof p.ref === 'string' ? p.ref : '';
    if (!names.length && !ref) continue;
    for (const part of f.parts) {
      if (part.length < 4) continue;
      const coords = [];
      for (let i = 0; i + 1 < part.length; i += 2)
        coords.push(tileToLatLon(x, y, part[i] / ext, part[i + 1] / ext, z).map(round6));
      out.push({
        names: [...new Set(names)],
        ref,
        network: typeof p.network === 'string' ? p.network : '',
        cls: typeof p.class === 'string' ? p.class : '',
        coords,
      });
    }
  }
  return out;
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * A road loader for lookupIntersection: (near, ring, signal) -> lines in the
 * (2 ring + 1)^2 tiles around `near`. Throws only when no tile could be read.
 * @param {{ getJson: Function, getBytes: Function }} proxyClient
 * @param {{ keep?: number, concurrency?: number }} [opts]
 */
export function createRoadTileLoader(proxyClient, { keep = 64, concurrency = 6 } = {}) {
  if (!proxyClient?.getBytes || !proxyClient?.getJson) return null;
  let tileset = null; // Promise<string>
  const tiles = new Map(); // "x/y" -> Promise<lines[]>, least recently used first

  function set() {
    tileset ??= proxyClient.getJson(TILESET_FEED, '/planet').then((j) => {
      const m = TILESET.exec(String(j?.tiles?.[0] ?? ''));
      if (!m) throw new Error('road tiles: unexpected tile set description');
      return m[1];
    });
    return tileset.catch((err) => {
      tileset = null;
      throw err;
    });
  }

  function tile(x, y) {
    const key = `${x}/${y}`;
    const hit = tiles.get(key);
    if (hit) {
      tiles.delete(key);
      tiles.set(key, hit);
      return hit;
    }
    const p = set()
      .then((s) =>
        proxyClient.getBytes(TILES_FEED, `/planet/${s}/${ROAD_ZOOM}/${x}/${y}.pbf`),
      )
      .then((bytes) => tileContent(bytes, x, y));
    p.catch(() => tiles.delete(key));
    tiles.set(key, p);
    while (tiles.size > keep) tiles.delete(tiles.keys().next().value);
    return p;
  }

  // The decoded tiles around `near`, `pick` from each: the road lines (the
  // loader itself) or the places (loadRoads.pois).
  async function around(near, ring, signal, pick) {
    const c = tileOf(Number(near.lat), Number(near.lon));
    const want = tilesAround(c.x, c.y, Math.max(0, Math.min(4, ring)));
    const results = new Array(want.length);
    let next = 0;
    // A few at a time, nearest first.
    const worker = async () => {
      while (next < want.length) {
        const i = next;
        next += 1;
        results[i] = await tile(want[i].x, want[i].y).then(
          (content) => pick(content),
          () => null,
        );
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, want.length) }, worker));
    if (signal?.aborted)
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (!results.some(Boolean)) throw new Error('road tiles unavailable');
    return results.filter(Boolean).flat();
  }

  const loadRoads = (near, ring = 1, signal) =>
    around(near, ring, signal, (c) => c.lines);
  /** The places in the (2 ring + 1)^2 tiles around `near` (the same tiles, kept once). */
  loadRoads.pois = (near, ring = 1, signal) => around(near, ring, signal, (c) => c.pois);
  return loadRoads;
}
