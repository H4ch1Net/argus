// Street-level photos from Mapillary (API v4): query building, parsing and the
// thumbnail rewrite onto the proxy. Pure (no Cesium), shared with the terminal.
//
// The layer loads only when zoomed in: the view is cut into 0.01 degree tiles
// (Mapillary refuses large boxes, and snapped tiles let nearby views share the
// proxy's cache), at most a few per view, nearest the middle first. Response
// shape per Mapillary's API v4 documentation: { data: [{ id, captured_at (ms),
// compass_angle (deg), geometry: { type: 'Point', coordinates: [lon, lat] },
// thumb_256_url, thumb_1024_url, is_pano }] }. Not live-tested here (no token
// in the build environment).

export const MAPILLARY_FIELDS =
  'id,captured_at,compass_angle,geometry,thumb_256_url,thumb_1024_url,is_pano';
export const MAPILLARY_TILE_DEG = 0.01;
/** A view wider than this (degrees) is too far out to load photos. */
export const MAPILLARY_MAX_VIEW_DEG = 0.04;
export const MAPILLARY_LIMIT = '100';
export const MAPILLARY_CREDIT = 'Street photos © Mapillary, CC BY-SA 4.0';

const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** True when a view box is small enough to load photos for. */
export function viewSmallEnough(bbox, maxDeg = MAPILLARY_MAX_VIEW_DEG) {
  return Boolean(
    bbox && bbox.lamax - bbox.lamin <= maxDeg && bbox.lomax - bbox.lomin <= maxDeg,
  );
}

/** The 0.01 degree tile containing a point. */
export function tileAt(lat, lon) {
  const d = MAPILLARY_TILE_DEG;
  const ix = Math.floor(lon / d);
  const iy = Math.floor(lat / d);
  return {
    key: `${ix}/${iy}`,
    lomin: r6(ix * d),
    lamin: r6(iy * d),
    lomax: r6((ix + 1) * d),
    lamax: r6((iy + 1) * d),
  };
}

/**
 * Tiles covering a view box, nearest its middle first, at most `max`; none
 * when the view is too wide.
 */
export function mapillaryTiles(bbox, max = 6, maxDeg = MAPILLARY_MAX_VIEW_DEG) {
  if (!viewSmallEnough(bbox, maxDeg)) return [];
  const d = MAPILLARY_TILE_DEG;
  const cLat = (bbox.lamin + bbox.lamax) / 2;
  const cLon = (bbox.lomin + bbox.lomax) / 2;
  const out = [];
  for (let iy = Math.floor(bbox.lamin / d); iy * d < bbox.lamax; iy += 1) {
    for (let ix = Math.floor(bbox.lomin / d); ix * d < bbox.lomax; ix += 1) {
      const t = tileAt((iy + 0.5) * d, (ix + 0.5) * d);
      t.dist = Math.hypot((iy + 0.5) * d - cLat, (ix + 0.5) * d - cLon);
      out.push(t);
    }
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, max);
}

/** Query params for one tile (pinned at the proxy: proxy/feeds/streets.js). */
export function mapillaryQuery(tile, limit = MAPILLARY_LIMIT) {
  return {
    bbox: `${tile.lomin},${tile.lamin},${tile.lomax},${tile.lamax}`,
    fields: MAPILLARY_FIELDS,
    limit,
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\//i.test(v) ? v : null);

/**
 * Mapillary /images JSON -> plain images: { id, lon, lat, capturedAt (ms),
 * compass (deg or null), pano, thumb256, thumb1024 } (thumbs as the API gave
 * them). Images without a point are skipped.
 */
export function parseMapillaryImages(json) {
  const list = Array.isArray(json?.data) ? json.data : [];
  const out = [];
  for (const d of list) {
    const id =
      typeof d?.id === 'string' || typeof d?.id === 'number' ? String(d.id) : null;
    const c = d?.geometry?.type === 'Point' ? d.geometry.coordinates : null;
    if (!id || !/^\d{1,24}$/.test(id) || !Array.isArray(c)) continue;
    const lon = num(c[0]);
    const lat = num(c[1]);
    if (lon === null || lat === null || Math.abs(lat) > 90 || Math.abs(lon) > 180)
      continue;
    const compass = num(d.compass_angle);
    out.push({
      id,
      lon,
      lat,
      capturedAt: num(d.captured_at),
      compass:
        compass === null
          ? null
          : compass >= 0 && compass < 360
            ? compass
            : ((compass % 360) + 360) % 360,
      pano: d.is_pano === true,
      thumb256: httpsUrl(d.thumb_256_url),
      thumb1024: httpsUrl(d.thumb_1024_url),
    });
  }
  return out;
}

// Meta's image CDN, where Mapillary's signed thumbnails live.
const THUMB_HOST = /^scontent(?:[.-][a-z0-9-]+)*\.fbcdn\.net$/i;
const THUMB_PATH = /^\/m1\/v\/t\d{1,2}\/[A-Za-z0-9_.-]{8,1024}$/;

/**
 * A thumbnail URL as a path and params for the proxy's image-only
 * 'mapillary-img' feed, or null for anything that is not a Mapillary
 * thumbnail on Meta's CDN (so the browser never loads a third-party host).
 */
export function mapillaryThumbPath(url) {
  if (typeof url !== 'string' || !URL.canParse(url)) return null;
  const u = new URL(url);
  if (u.protocol !== 'https:' || !THUMB_HOST.test(u.hostname)) return null;
  if (!THUMB_PATH.test(u.pathname)) return null;
  return { path: u.pathname, params: Object.fromEntries(u.searchParams) };
}

/** A thumbnail through the proxy, given the proxy client's buildUrl. */
export function proxiedThumb(buildUrl, url) {
  const p = mapillaryThumbPath(url);
  return p ? buildUrl('mapillary-img', p.path, p.params) : null;
}

/** A plain image -> the layer's normalized entity. */
export function streetPhotoToNormalized(img) {
  return {
    id: `mly-${img.id}`,
    type: 'streetphoto',
    position: { longitude: img.lon, latitude: img.lat, altitude: 0 },
    meta: {
      imageId: img.id,
      capturedAt: img.capturedAt,
      compass: img.compass,
      pano: img.pano,
      image: img.image ?? null, // the proxied thumbnail, set by the source
      demo: Boolean(img.demo),
      source: img.demo ? 'demo (simulated)' : 'Mapillary',
    },
  };
}

/** Metres between two points (equirectangular; for "nearest" within a km). */
export function nearM(aLat, aLon, bLat, bLon) {
  const k = Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
  return Math.hypot((bLat - aLat) * 110_540, (bLon - aLon) * 111_320 * k);
}

/** The image nearest a point within maxM, or null. */
export function nearestImage(images, lat, lon, maxM = 400) {
  let best = null;
  let bestD = maxM;
  for (const img of images) {
    const d = nearM(lat, lon, img.lat, img.lon);
    if (d <= bestD) {
      best = img;
      bestD = d;
    }
  }
  return best ? { image: best, distanceM: bestD } : null;
}
