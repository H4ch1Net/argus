// Tiled, fetch-once Overpass loading for the static OSM layers (the "eyes",
// traffic lights, landmarks) and the NEARBY LANDMARKS tool. Pure: no Cesium,
// no DOM, so the terminal shell uses the same loader.
//
// Things on the ground that rarely change (cameras, ALPR readers, traffic
// lights, monuments) are fetched once per fixed tile of the grid and kept for
// hours, not refetched on every pan: a view is covered by the tiles it
// touches, nearest the anchor first; a tile already held is used as is; a
// missing one is fetched once (one request in flight per tile however many
// views ask for it) and kept until its time to live runs out or the user
// presses RELOAD (source.reload()). A failed tile is not kept and is retried
// only after a pause, so an Overpass outage cannot turn panning into a
// request storm. All tiled sources share one small request queue (Overpass
// allows a couple of concurrent requests per client).
//
// Grid: tile (ix, iy) of size tileDeg spans lon -180 + ix*tileDeg .. +tileDeg
// and lat -90 + iy*tileDeg .. +tileDeg; its key is `${tileDeg}/${ix}/${iy}`
// (the 'z/x/y'-style key the Layer SDK's tile cache passes as query.tile, so a
// one-tile query from the SDK maps onto exactly one tile here).

const EPS = 1e-9;
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON = 111.32;
const D2R = Math.PI / 180;

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/** The bbox ({ lamin, lomin, lamax, lomax }, degrees) of one tile. */
export function tileBBox(tileDeg, ix, iy) {
  return {
    lamin: round6(-90 + iy * tileDeg),
    lamax: round6(-90 + (iy + 1) * tileDeg),
    lomin: round6(-180 + ix * tileDeg),
    lomax: round6(-180 + (ix + 1) * tileDeg),
  };
}

/**
 * The tiles a bbox touches: [{ key, ix, iy, bbox, lat, lon }] (lat/lon: the
 * tile's centre). Edges that fall exactly on a tile boundary do not pull in
 * the next tile.
 */
export function tilesCovering(bbox, tileDeg) {
  const nx = Math.round(360 / tileDeg);
  const ny = Math.round(180 / tileDeg);
  const clamp = (v, n) => Math.max(0, Math.min(n - 1, v));
  const ix0 = clamp(Math.floor((bbox.lomin + 180) / tileDeg + EPS), nx);
  const ix1 = clamp(Math.ceil((bbox.lomax + 180) / tileDeg - EPS) - 1, nx);
  const iy0 = clamp(Math.floor((bbox.lamin + 90) / tileDeg + EPS), ny);
  const iy1 = clamp(Math.ceil((bbox.lamax + 90) / tileDeg - EPS) - 1, ny);
  const out = [];
  for (let iy = iy0; iy <= Math.max(iy0, iy1); iy += 1) {
    for (let ix = ix0; ix <= Math.max(ix0, ix1); ix += 1) {
      const b = tileBBox(tileDeg, ix, iy);
      out.push({
        key: `${tileDeg}/${ix}/${iy}`,
        ix,
        iy,
        bbox: b,
        lat: (b.lamin + b.lamax) / 2,
        lon: (b.lomin + b.lomax) / 2,
      });
    }
  }
  return out;
}

/** A view's size in km: { w, h, across } (across: the square root of the area). */
export function viewSizeKm(bbox) {
  const mid = ((bbox.lamin + bbox.lamax) / 2) * D2R;
  const w = Math.max(0, bbox.lomax - bbox.lomin) * KM_PER_DEG_LON * Math.cos(mid);
  const h = Math.max(0, bbox.lamax - bbox.lamin) * KM_PER_DEG_LAT;
  return { w, h, across: Math.sqrt(w * h) };
}

/** A bbox of radiusKm around a point. */
export function bboxAround({ lat, lon }, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLon = radiusKm / (KM_PER_DEG_LON * Math.max(0.05, Math.cos(lat * D2R)));
  return {
    lamin: Math.max(-90, lat - dLat),
    lamax: Math.min(90, lat + dLat),
    lomin: Math.max(-180, lon - dLon),
    lomax: Math.min(180, lon + dLon),
  };
}

/** Squared equirectangular distance in degrees (for ordering only). */
export function d2(a, b) {
  const k = Math.cos(((a.lat + b.lat) / 2) * D2R);
  return ((a.lon - b.lon) * k) ** 2 + (a.lat - b.lat) ** 2;
}

/** Overpass bbox text, south,west,north,east. */
export function bboxText(b) {
  return `${round6(b.lamin)},${round6(b.lomin)},${round6(b.lamax)},${round6(b.lomax)}`;
}

/**
 * A small time-limited, size-limited store of tile results.
 * @param {{ ttlMs: number, maxTiles: number, now?: () => number }} opts
 */
export function createTileStore({ ttlMs, maxTiles, now = () => Date.now() }) {
  const map = new Map(); // key -> { at, value } (insertion order = age)
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (now() - e.at > ttlMs) {
        map.delete(key);
        return undefined;
      }
      return e.value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, { at: now(), value });
      while (map.size > maxTiles) map.delete(map.keys().next().value);
    },
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
}

// --- the shared request queue ----------------------------------------------

/** A FIFO limiter: run(task) starts task() once fewer than max are running. */
export function createLimiter(max = 2) {
  let running = 0;
  const queue = [];
  const next = () => {
    while (running < max && queue.length) {
      const { task, resolve, reject } = queue.shift();
      running += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          next();
        });
    }
  };
  return {
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        next();
      });
    },
    get running() {
      return running;
    },
    get queued() {
      return queue.length;
    },
  };
}

// Overpass's public instance gives each client a couple of slots: every tiled
// source in the app queues through this one limiter.
const sharedLimiter = createLimiter(2);

/**
 * Overpass reports timeouts and overload as HTTP 200 with a `remark`: that is
 * a failure, never a result to keep.
 */
export function checkOverpass(json) {
  const remark = json?.remark ? String(json.remark) : '';
  if (remark && (/error|timed out|timeout/i.test(remark) || !json.elements?.length))
    throw new Error(`Overpass: ${remark.slice(0, 120)}`);
  if (!Array.isArray(json?.elements)) throw new Error('Overpass: no elements');
  return json;
}

/**
 * The tile loader: a store, the tiles wanted right now, and one fetch per
 * missing tile.
 * @param {{
 *   fetchTile: (bbox: object) => Promise<object>,   raw Overpass JSON for a tile
 *   parse: (json: object) => object[],               normalized records
 *   tileDeg: number, ttlMs: number, maxTiles: number,
 *   retryMs?: number, limiter?: object, now?: () => number,
 * }} opts
 */
export function createTileLoader({
  fetchTile,
  parse,
  tileDeg,
  ttlMs,
  maxTiles,
  retryMs = 45_000,
  limiter = sharedLimiter,
  now = () => Date.now(),
}) {
  const store = createTileStore({ ttlMs, maxTiles, now });
  const inflight = new Map(); // key -> Promise<list|null>
  const failedAt = new Map(); // key -> time of the last failure
  const wants = new Map(); // owner -> keys its latest pass asked for
  const wanted = { has: (key) => [...wants.values()].some((s) => s.has(key)) };
  let epoch = 0; // bumped by reload(): fetches started before it are not kept

  function load(tile) {
    const have = store.get(tile.key);
    if (have) return Promise.resolve(have);
    const running = inflight.get(tile.key);
    if (running) return running;
    const t = failedAt.get(tile.key);
    if (t !== undefined && now() - t < retryMs) return Promise.resolve(null);
    const started = epoch;
    const p = limiter
      .run(async () => {
        // Panned away while queued: nothing to fetch.
        if (!wanted.has(tile.key)) return null;
        const json = checkOverpass(await fetchTile(tile.bbox));
        return parse(json);
      })
      .then(
        (list) => {
          if (list && started === epoch) {
            store.set(tile.key, list);
            failedAt.delete(tile.key);
          }
          return list;
        },
        (err) => {
          failedAt.set(tile.key, now());
          console.warn(`[argus] OSM tile ${tile.key}: ${err?.message || err}`);
          return null;
        },
      )
      .finally(() => inflight.delete(tile.key));
    inflight.set(tile.key, p);
    return p;
  }

  return {
    tileDeg,
    load,
    /**
     * Mark the tiles a pass wants; a queued tile that no owner (a layer, the
     * NEARBY list) wants any more is skipped when its turn comes.
     */
    want(tiles, owner = 'view') {
      wants.set(owner, new Set(tiles.map((t) => t.key)));
    },
    cached: (key) => store.get(key),
    isFailed: (key) => {
      const t = failedAt.get(key);
      return t !== undefined && now() - t < retryMs;
    },
    isLoading: (key) => inflight.has(key),
    /** Forget everything held (RELOAD). */
    reload() {
      epoch += 1;
      store.clear();
      failedAt.clear();
    },
    get size() {
      return store.size;
    },
  };
}

/** Merge per-tile lists, first id wins (a way on a tile edge comes back twice). */
export function mergeTiles(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!list) continue;
    for (const n of list) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

/**
 * A viewport source over a tile loader, for the Layer SDK ('viewport' mode)
 * and the terminal engine: source(query, signal) resolves to
 * { items, tiles, loaded, pending, failed, partial, tooWide }, where items are
 * normalized records (the definition's normalize returns raw.items).
 *
 * Views wider than maxViewKm (square root of the area) load nothing and say
 * so; a view needing more than maxViewTiles tiles loads the ones nearest the
 * anchor (partial). With onUpdate (the globe), a pass waits only for the
 * tile under the anchor (up to firstWaitMs) and the rest arrive in the
 * background, each landing calling onUpdate() (debounced) so the layer
 * refreshes from what is now held; without it (the terminal) a pass waits
 * for all of its tiles.
 *
 * @param {ReturnType<typeof createTileLoader>} loader
 * @param {{ maxViewKm?: number, maxViewTiles?: number|(() => number),
 *   anchor?: () => ({ lat: number, lon: number })|null,
 *   onUpdate?: () => void, firstWaitMs?: number, debounceMs?: number }} [opts]
 */
export function createTiledSource(
  loader,
  {
    maxViewKm = Infinity,
    maxViewTiles = 9,
    anchor,
    onUpdate,
    firstWaitMs = 8000,
    debounceMs = 400,
  } = {},
) {
  let updateTimer = null;
  const landed = () => {
    if (!onUpdate) return;
    clearTimeout(updateTimer);
    updateTimer = setTimeout(onUpdate, debounceMs);
  };

  async function source(query, signal) {
    const bbox = query?.bbox;
    const empty = {
      items: [],
      tiles: 0,
      loaded: 0,
      pending: 0,
      failed: 0,
      partial: false,
      tooWide: false,
    };
    if (!bbox) return empty;
    // RELOAD (query.reload, from the Layer SDK): every held tile counts as
    // expired; what is drawn stays until the new answers land.
    if (query.reload) loader.reload();
    if (viewSizeKm(bbox).across > maxViewKm) return { ...empty, tooWide: true };
    const all = tilesCovering(bbox, loader.tileDeg);
    const a = anchor?.() ?? {
      lat: (bbox.lamin + bbox.lamax) / 2,
      lon: (bbox.lomin + bbox.lomax) / 2,
    };
    all.sort((p, q) => d2(p, a) - d2(q, a));
    const cap = typeof maxViewTiles === 'function' ? maxViewTiles() : maxViewTiles;
    const chosen = all.slice(0, Math.max(1, cap));
    loader.want(chosen);
    const held = chosen.map((t) => Boolean(loader.cached(t.key)));
    const loads = chosen.map((t) => loader.load(t));
    // Only a tile that arrives from the network refreshes the layer (a held
    // one is already in this pass's result, so it must not loop).
    loads.forEach((p, i) => !held[i] && p.then((list) => list && landed()));
    if (onUpdate) {
      // Wait for the nearest tile only (unless it is held already).
      if (!held[0]) await raceAbort(loads[0], signal, firstWaitMs);
    } else {
      await raceAbort(Promise.all(loads), signal, Infinity);
    }
    const lists = chosen.map((t) => loader.cached(t.key));
    return {
      items: mergeTiles(lists),
      tiles: chosen.length,
      loaded: lists.filter(Boolean).length,
      pending: chosen.filter((t) => loader.isLoading(t.key)).length,
      failed: chosen.filter((t) => loader.isFailed(t.key)).length,
      partial: all.length > chosen.length,
      tooWide: false,
    };
  }
  /** Drop every held tile; the next pass fetches again (RELOAD). */
  source.reload = () => loader.reload();
  source.loader = loader;
  return source;
}

/**
 * Everything held or fetchable within radiusKm of a point, waiting for all of
 * it (the NEARBY LANDMARKS list): { items, failed }.
 */
export async function loadAround(loader, at, radiusKm, { maxTiles = 9 } = {}) {
  const tiles = tilesCovering(bboxAround(at, radiusKm), loader.tileDeg)
    .sort((p, q) => d2(p, at) - d2(q, at))
    .slice(0, maxTiles);
  loader.want(tiles, 'around');
  const lists = await Promise.all(tiles.map((t) => loader.load(t)));
  return { items: mergeTiles(lists), failed: lists.filter((l) => !l).length };
}

/** Wait for p, but give up on abort (AbortError) or after ms (resolves). */
function raceAbort(p, signal, ms) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = (fn, v) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(v);
    };
    const onAbort = () => done(reject, abortError());
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (Number.isFinite(ms)) timer = setTimeout(() => done(resolve), ms);
    p.then(
      (v) => done(resolve, v),
      (e) => done(reject, e),
    );
  });
}

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * The status line for a tiled pass (shared by the globe and the terminal):
 * '' when complete, else what is missing.
 */
export function tiledNote(raw, { tooWide = 'zoom in to load' } = {}) {
  if (!raw) return '';
  if (raw.tooWide) return tooWide;
  const parts = [];
  if (raw.pending)
    parts.push(`loading ${raw.pending} area${raw.pending === 1 ? '' : 's'}`);
  if (raw.failed) parts.push(`${raw.failed} area${raw.failed === 1 ? '' : 's'} failed`);
  if (raw.partial) parts.push('zoom in for all');
  return parts.join(' · ');
}

/**
 * An Overpass fetcher through the proxy for a query builder:
 * (bbox) => Promise<json>. Per the proxy's 'overpass' feed (GET /interpreter).
 */
export function overpassFetcher(proxyClient, buildQuery) {
  return (bbox) =>
    proxyClient.getJson('overpass', '/interpreter', {
      params: { data: buildQuery(bbox) },
    });
}
