// Fetch once: the static-layer tile cache of the Layer SDK. Pure (no Cesium).
//
// Infrastructure that does not move (cameras, ALPR readers, dams, data
// centres, landmarks) is fetched per fixed tile of the globe, not per view: a
// layer declares fetch: { mode: 'viewport', tileCache: { tileDeg, ttlMs,
// maxTiles } } and the SDK asks its source once per tile (query.bbox = the
// tile's box, query.tile = its key), keeps each tile's answer for ttlMs, and
// draws the union of the cached tiles (deduplicated by id, nearest first).
// Panning back over a city costs nothing; a cached tile is fetched again only
// once it expires or the user presses RELOAD (layer.reload()).

export const TILE_DEFAULTS = Object.freeze({
  tileDeg: 0.5,
  ttlMs: 6 * 60 * 60 * 1000,
  maxTiles: 32,
  // A view needing more tiles than this is too broad: nothing new is fetched
  // ("zoom in to load"), cached tiles still show. 7 x 7 half-degree tiles
  // cover the 3 degree view the Overpass layers loaded before they were tiled.
  maxView: 49,
  concurrency: 2, // tiles in flight at once (Overpass allows few per client)
  retryMs: 60_000, // a failed tile is not asked again sooner than this
});

/** The full options of a tileCache declaration (defaults filled in). */
export function tileOptions(cfg = {}) {
  const o = { ...TILE_DEFAULTS, ...(cfg === true ? {} : cfg) };
  // Whole tiles in a 180 x 360 degree grid.
  o.tileDeg = 180 / Math.max(1, Math.round(180 / Math.max(0.05, o.tileDeg)));
  // The cache must hold a whole view, or the tiles of one view would evict
  // each other and be fetched over and over.
  o.maxTiles = Math.max(o.maxTiles, o.maxView + 8);
  return o;
}

const fix = (v) => Number(v.toFixed(6));

/** A tile's key, 'z/x/y'-style: the tile size in degrees, column, row. */
export const tileKey = (tileDeg, x, y) => `${fix(tileDeg)}/${x}/${y}`;

/** A tile's box in degrees (the same shape as a viewport query's bbox). */
export function tileBBox(tileDeg, x, y) {
  return {
    lamin: fix(-90 + y * tileDeg),
    lamax: fix(Math.min(90, -90 + (y + 1) * tileDeg)),
    lomin: fix(-180 + x * tileDeg),
    lomax: fix(Math.min(180, -180 + (x + 1) * tileDeg)),
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The tiles covering a view bbox, nearest the view's centre first. A view
 * across the antimeridian (bbox.wrap from the SDK's viewport query) is covered
 * on both sides instead of around the whole globe.
 * @returns {{ key: string, x: number, y: number, bbox: object, d: number }[]}
 */
export function tilesForView(bbox, tileDeg) {
  if (!bbox) return [];
  const nx = Math.round(360 / tileDeg);
  const ny = Math.round(180 / tileDeg);
  const eps = 1e-9;
  const y0 = clamp(Math.floor((bbox.lamin + 90) / tileDeg), 0, ny - 1);
  const y1 = clamp(Math.floor((bbox.lamax + 90) / tileDeg - eps), 0, ny - 1);
  const spans = bbox.wrap
    ? [
        [bbox.wrap.west, 180],
        [-180, bbox.wrap.east],
      ]
    : [[bbox.lomin, bbox.lomax]];
  // The view's centre, for the nearest-first order.
  const cLat = (bbox.lamin + bbox.lamax) / 2;
  const cLon = bbox.wrap
    ? (((((bbox.wrap.west + bbox.wrap.east + 360) / 2 + 180) % 360) + 360) % 360) - 180
    : (bbox.lomin + bbox.lomax) / 2;
  const cosLat = Math.cos((cLat * Math.PI) / 180);
  const out = [];
  const seen = new Set();
  for (const [w, e] of spans) {
    const x0 = clamp(Math.floor((w + 180) / tileDeg), 0, nx - 1);
    const x1 = clamp(Math.floor((e + 180) / tileDeg - eps), 0, nx - 1);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const key = tileKey(tileDeg, x, y);
        if (seen.has(key)) continue;
        seen.add(key);
        const b = tileBBox(tileDeg, x, y);
        let dLon = Math.abs((b.lomin + b.lomax) / 2 - cLon);
        if (dLon > 180) dLon = 360 - dLon;
        const dLat = (b.lamin + b.lamax) / 2 - cLat;
        out.push({ key, x, y, bbox: b, d: Math.hypot(dLon * cosLat, dLat) });
      }
    }
  }
  return out.sort((a, b) => a.d - b.d);
}

/**
 * How many tiles tilesForView would list, without listing them (a whole-globe
 * view at a quarter degree is a million tiles: refuse it before building any).
 */
export function tileCountForView(bbox, tileDeg) {
  if (!bbox) return 0;
  const nx = Math.round(360 / tileDeg);
  const ny = Math.round(180 / tileDeg);
  const eps = 1e-9;
  const y0 = clamp(Math.floor((bbox.lamin + 90) / tileDeg), 0, ny - 1);
  const y1 = clamp(Math.floor((bbox.lamax + 90) / tileDeg - eps), 0, ny - 1);
  const spans = bbox.wrap
    ? [
        [bbox.wrap.west, 180],
        [-180, bbox.wrap.east],
      ]
    : [[bbox.lomin, bbox.lomax]];
  let cols = 0;
  for (const [w, e] of spans) {
    const x0 = clamp(Math.floor((w + 180) / tileDeg), 0, nx - 1);
    const x1 = clamp(Math.floor((e + 180) / tileDeg - eps), 0, nx - 1);
    cols += Math.max(0, x1 - x0 + 1);
  }
  return Math.max(0, y1 - y0 + 1) * cols;
}

/**
 * The cache: tile key -> { key, bbox, at, raw, list }, least recently used
 * first, at most maxTiles. Failed tiles are remembered apart, so a broken
 * upstream is not asked again before retryMs.
 */
export function createTileStore({
  ttlMs = TILE_DEFAULTS.ttlMs,
  maxTiles = TILE_DEFAULTS.maxTiles,
  retryMs = TILE_DEFAULTS.retryMs,
  now = () => Date.now(),
} = {}) {
  const tiles = new Map();
  const failed = new Map(); // key -> time of the failure
  return {
    get: (key) => tiles.get(key),
    has: (key) => tiles.has(key),
    /** Cached and younger than ttlMs. */
    isFresh(key) {
      const t = tiles.get(key);
      return Boolean(t) && now() - t.at < ttlMs;
    },
    /** Failed less than retryMs ago: do not ask again yet. */
    isCoolingDown(key) {
      const at = failed.get(key);
      return at !== undefined && now() - at < retryMs;
    },
    set(key, entry) {
      tiles.delete(key);
      failed.delete(key);
      tiles.set(key, { ...entry, key, at: entry.at ?? now() });
      while (tiles.size > maxTiles) tiles.delete(tiles.keys().next().value);
      return tiles.get(key);
    },
    fail(key) {
      failed.set(key, now());
      while (failed.size > maxTiles) failed.delete(failed.keys().next().value);
    },
    /** Mark a tile as just used (it is evicted last). */
    touch(key) {
      const t = tiles.get(key);
      if (!t) return;
      tiles.delete(key);
      tiles.set(key, t);
    },
    clear() {
      tiles.clear();
      failed.clear();
    },
    /** Treat every tile as expired (RELOAD): still served, fetched again. */
    expireAll() {
      for (const t of tiles.values()) t.at = -Infinity;
      failed.clear();
    },
    values: () => tiles.values(),
    get size() {
      return tiles.size;
    },
  };
}

/**
 * The records of several tiles as one list: first occurrence of an id wins
 * (a feature on a tile edge comes back from both tiles), at most max.
 * entries: [{ list: NormalizedEntity[] }] in the order to keep (nearest first).
 */
export function mergeTileRecords(entries, max = Infinity) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    for (const n of e?.list ?? []) {
      if (out.length >= max) return out;
      if (n == null || seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}
