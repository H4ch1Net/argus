// One Overpass client, shared by the OSM-derived layers (landmarks, the "eyes").
//
// Overpass is free but slow and rate-limited, so this is deliberately not a
// polling feed (see the SDK 'viewport' mode): it fetches once per region, and
// aggressively caches. Queries are refused when the view is too broad (Overpass
// would be very slow and return far too much), snapped to a coarse grid so small
// pans reuse a cached result, and capped in element count.

const CACHE_TTL_MS = 10 * 60 * 1000;
const GRID_STEP = 0.1; // degrees; snapping the bbox lets nearby views share a cache entry
const cache = new Map(); // ql -> { at, data }

export function snapBBox(bbox) {
  return {
    lamin: Math.floor(bbox.lamin / GRID_STEP) * GRID_STEP,
    lomin: Math.floor(bbox.lomin / GRID_STEP) * GRID_STEP,
    lamax: Math.ceil(bbox.lamax / GRID_STEP) * GRID_STEP,
    lomax: Math.ceil(bbox.lomax / GRID_STEP) * GRID_STEP,
  };
}

export function areaTooLarge(bbox, maxDeg) {
  return bbox.lamax - bbox.lamin > maxDeg || bbox.lomax - bbox.lomin > maxDeg;
}

/**
 * Build an Overpass QL query. `filters` are element selectors, e.g.
 * `node["man_made"="surveillance"]`. Overpass bbox order is (south,west,north,east).
 */
export function buildBBoxQuery(filters, bbox) {
  const box = `${bbox.lamin},${bbox.lomin},${bbox.lamax},${bbox.lomax}`;
  const body = filters.map((f) => `${f}(${box});`).join('');
  return `[out:json][timeout:25];(${body});out center 2000;`;
}

/**
 * Create a viewport-mode source over Overpass.
 * @param {{ proxyClient: object, filters: string[], maxAreaDeg?: number }} opts
 */
export function createOverpassSource({ proxyClient, filters, maxAreaDeg = 3 }) {
  return async (query, signal) => {
    const bbox = query?.bbox;
    if (!bbox || areaTooLarge(bbox, maxAreaDeg)) return { elements: [] }; // too broad: skip
    const ql = buildBBoxQuery(filters, snapBBox(bbox));

    const hit = cache.get(ql);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

    const data = await proxyClient.getJson('overpass', '/interpreter', {
      params: { data: ql },
      signal,
    });
    cache.set(ql, { at: Date.now(), data });
    return data;
  };
}
