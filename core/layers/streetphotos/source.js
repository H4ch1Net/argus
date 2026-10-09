import {
  mapillaryQuery,
  mapillaryTiles,
  nearestImage,
  parseMapillaryImages,
  proxiedThumb,
  tileAt,
  viewSmallEnough,
} from './parse.js';

// The street photo source: Mapillary images for the tiles of a zoomed-in view
// through the proxy's pinned 'mapillary' feed (MAPILLARY_TOKEN injected
// server side), each tile cached 30 minutes here as well as at the proxy, and
// every thumbnail rewritten onto the image-only 'mapillary-img' feed. Pure: no
// Cesium; the terminal uses it too. Also the lookup behind STREET PHOTO on any
// target card: the image nearest a point.

const TILE_TTL_MS = 30 * 60_000;
const TILE_MAX = 48;
const MAX_IMAGES = 600;

/** @param {{ proxyClient: object, now?: () => number }} opts */
export function createStreetPhotoTiles({ proxyClient, now = () => Date.now() }) {
  const cache = new Map(); // tile key -> { images, at }
  async function tile(t, signal) {
    const hit = cache.get(t.key);
    if (hit && now() - hit.at < TILE_TTL_MS) return hit.images;
    const json = await proxyClient.getJson('mapillary', '/images', {
      params: mapillaryQuery(t),
      signal,
    });
    const images = parseMapillaryImages(json).map((img) => ({
      ...img,
      image: proxiedThumb(proxyClient.buildUrl, img.thumb1024 ?? img.thumb256),
    }));
    cache.delete(t.key);
    cache.set(t.key, { images, at: now() });
    while (cache.size > TILE_MAX) cache.delete(cache.keys().next().value);
    return images;
  }
  return { tile };
}

/** The viewport source for the layer: { images, tooWide }. */
export function createStreetPhotoSource({ proxyClient, tiles = null }) {
  const t = tiles ?? createStreetPhotoTiles({ proxyClient });
  return async (query, signal) => {
    const bbox = query?.bbox;
    if (!viewSmallEnough(bbox)) return { images: [], tooWide: true };
    const seen = new Map();
    for (const tl of mapillaryTiles(bbox)) {
      for (const img of await t.tile(tl, signal))
        if (!seen.has(img.id)) seen.set(img.id, img);
      if (seen.size >= MAX_IMAGES) break;
    }
    return { images: [...seen.values()].slice(0, MAX_IMAGES), tooWide: false };
  };
}

/**
 * The photo nearest a point: the tile it is in, then its neighbours nearest
 * first, until one has an image within maxM. Returns { image, distanceM } or null.
 */
export async function findNearestStreetPhoto(
  tiles,
  lat,
  lon,
  { maxM = 400, signal } = {},
) {
  const home = tileAt(lat, lon);
  const d = home.lamax - home.lamin;
  const ring = [home];
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const n = tileAt(lat + dy * d, lon + dx * d);
    n.dist = Math.min(
      Math.abs(dx ? (dx > 0 ? home.lomax - lon : lon - home.lomin) : Infinity),
      Math.abs(dy ? (dy > 0 ? home.lamax - lat : lat - home.lamin) : Infinity),
    );
    ring.push(n);
  }
  const order = [ring[0], ...ring.slice(1).sort((a, b) => a.dist - b.dist)];
  const pool = [];
  for (const t of order) {
    pool.push(...(await tiles.tile(t, signal)));
    const best = nearestImage(pool, lat, lon, maxM);
    // A neighbour can only hold something nearer if the point is close to it.
    const nextGapM = order[order.indexOf(t) + 1]?.dist * 111_000;
    if (best && !(nextGapM < best.distanceM)) return best;
  }
  return nearestImage(pool, lat, lon, maxM);
}
