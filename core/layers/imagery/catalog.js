// Recent imagery catalogue: what NASA has imaged over a box in the last 30 days,
// as one candidate per product and UTC day, and the raster spec / snapshot URL
// to show one. Products: HLS S30 (Sentinel-2) and HLS L30 (Landsat 8/9), found
// through NASA CMR and tiled by GIBS, plus the VIIRS NOAA-21 daily true-colour
// overview (a global mosaic with no catalogue, so one candidate per day).
//
// Adapted from gods-eye-view src/layers/recentImagery/model.js and catalog.js
// (MIT). Pure and Cesium-free: no DOM, no network of its own. Requests go
// through the proxy feeds 'cmr', 'gibs' and 'wvs' (proxy/feeds/imagery.js),
// addressed with the proxy client's buildUrl; the catalogue walk takes an
// injected page fetcher so it runs the same in a test, the browser or a terminal.
//
// Etiquette (NASA asks for no bulk use): one 30-day catalogue query per box,
// tiles bounded to the box, boxes at most 1000 km a side.

export const CATALOG_DAYS = 30;
export const MAX_BOX_SIDE_KM = 1000;
export const PIN_BOX_SIDE_KM = 10;
export const CMR_PAGE_SIZE = 200;
/** Most records read per collection; past it the newest days are kept. */
export const CMR_MAX_RECORDS = 2000;
/** CMR's paging cursor: a response header the next request sends back. */
export const CMR_SEARCH_AFTER = 'CMR-Search-After';
/** "Clear" means every granule that day reports at most this much cloud. */
export const MAX_CLOUD_FOR_CLEAR = 20;
/** Required acknowledgement wording for GIBS imagery (see core/credits.js). */
export const IMAGERY_CREDIT = 'NASA GIBS (ESDIS)';

/** GIBS EPSG:3857 tiles do not exist beyond the Web Mercator limit. */
const MERCATOR_LAT_LIMIT = 85.0511;
const KM_PER_DEG_LAT = 111.32;
const DAY_MS = 86_400_000;
const PRODUCT_ORDER = ['S30', 'L30', 'VIIRS'];
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/**
 * Keyless imagery products. HLS products are searched via CMR; the VIIRS
 * overview is a daily global mosaic with no granule catalogue.
 */
export const PRODUCTS = Object.freeze({
  S30: Object.freeze({
    label: 'HLS S30',
    sensor: 'Sentinel-2 via HLS',
    resolutionM: 30,
    gibsLayer: 'HLS_S30_Nadir_BRDF_Adjusted_Reflectance',
    maxLevel: 12,
    format: 'png',
    cmrCollection: 'C2021957295-LPCLOUD',
    overview: false,
  }),
  L30: Object.freeze({
    label: 'HLS L30',
    sensor: 'Landsat 8/9 via HLS',
    resolutionM: 30,
    gibsLayer: 'HLS_L30_Nadir_BRDF_Adjusted_Reflectance',
    maxLevel: 12,
    format: 'png',
    cmrCollection: 'C2021957657-LPCLOUD',
    overview: false,
  }),
  VIIRS: Object.freeze({
    label: 'VIIRS',
    sensor: 'VIIRS NOAA-21',
    resolutionM: 250,
    gibsLayer: 'VIIRS_NOAA21_CorrectedReflectance_TrueColor',
    maxLevel: 9,
    format: 'jpg',
    cmrCollection: null,
    overview: true,
  }),
});

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const toRad = (deg) => (deg * Math.PI) / 180;
const pad2 = (v) => String(v).padStart(2, '0');

// --- the selection box -------------------------------------------------------

/**
 * Coerce to { west, south, east, north } with south <= north. West and east are
 * NOT swapped: west > east means the box crosses the dateline, which
 * validateBox refuses. Null when an edge is not finite.
 */
function normalizeBox(box) {
  if (!box || typeof box !== 'object') return null;
  const [west, south, east, north] = [box.west, box.south, box.east, box.north].map(
    (v) => (v === null || v === '' ? NaN : Number(v)),
  );
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south: Math.min(south, north), east, north: Math.max(south, north) };
}

/** The SDK's viewport bbox ({ lamin, lomin, lamax, lomax }) as a box. */
export function boxFromBBox(bbox) {
  if (!bbox) return null;
  return normalizeBox({
    west: bbox.lomin,
    south: bbox.lamin,
    east: bbox.lomax,
    north: bbox.lamax,
  });
}

/**
 * Side lengths in km: the box's own longitude span (never the short way round)
 * at its mid-latitude, and its latitude span.
 */
export function boxSideKm(box) {
  const b = normalizeBox(box);
  if (!b) return { width: NaN, height: NaN };
  const midLat = (b.south + b.north) / 2;
  return {
    width: (b.east - b.west) * KM_PER_DEG_LAT * Math.cos(toRad(midLat)),
    height: (b.north - b.south) * KM_PER_DEG_LAT,
  };
}

const refuse = (reason, message) => ({ ok: false, reason, message });

/**
 * Validate a selection box for the catalogue and the tiles: finite, inside
 * +-180 / the Mercator limit, not crossing the dateline, enclosing an area, and
 * at most MAX_BOX_SIDE_KM a side.
 * @returns {{ ok: true, box: object } | { ok: false,
 *   reason: 'invalid'|'dateline'|'polar'|'degenerate'|'too-large', message: string }}
 */
export function validateBox(box) {
  const b = normalizeBox(box);
  if (!b) return refuse('invalid', 'Box edges must be finite');
  if (Math.abs(b.west) > 180 || Math.abs(b.east) > 180)
    return refuse('invalid', 'Longitudes must be within 180 degrees');
  if (b.west > b.east) return refuse('dateline', 'Select one side of the dateline');
  if (Math.abs(b.south) > MERCATOR_LAT_LIMIT || Math.abs(b.north) > MERCATOR_LAT_LIMIT)
    return refuse('polar', `Imagery stops at ${MERCATOR_LAT_LIMIT.toFixed(2)} degrees`);
  if (b.east === b.west || b.north === b.south)
    return refuse('degenerate', 'Box must enclose an area');
  const { width, height } = boxSideKm(b);
  if (width > MAX_BOX_SIDE_KM || height > MAX_BOX_SIDE_KM) {
    const km = Math.round(Math.max(width, height));
    return refuse('too-large', `Box is ${km} km wide, limit ${MAX_BOX_SIDE_KM} km`);
  }
  return { ok: true, box: b };
}

/**
 * A square box `sideKm` on the ground centred on a pin (the east-west span
 * widens by 1/cos(lat)); null when it would not validate.
 */
export function boxFromPin(lon, lat, sideKm = PIN_BOX_SIDE_KM) {
  if (!finite(lon) || !finite(lat) || !finite(sideKm) || sideKm <= 0) return null;
  const cosLat = Math.cos(toRad(lat));
  if (cosLat <= 0) return null;
  const halfLat = sideKm / 2 / KM_PER_DEG_LAT;
  const halfLon = sideKm / 2 / (KM_PER_DEG_LAT * cosLat);
  const clampLat = (v) => Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, v));
  const r = validateBox({
    west: lon - halfLon,
    south: clampLat(lat - halfLat),
    east: lon + halfLon,
    north: clampLat(lat + halfLat),
  });
  return r.ok ? r.box : null;
}

// --- days --------------------------------------------------------------------

function isValidDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!m) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day;
}

/** UTC calendar day (YYYY-MM-DD) of an ISO time, Date, epoch ms or day; else null. */
export function utcDay(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return isValidDay(value) ? value : null;
  const t =
    value instanceof Date ? value.getTime() : finite(value) ? value : Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/**
 * The catalogue window: `days` whole UTC days ending today. Quantized to days
 * so the same box asked again the same day is the same URL (a proxy cache hit).
 */
export function catalogWindow(now = Date.now(), days = CATALOG_DAYS) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(t)) throw new TypeError('A valid clock is required');
  const n = Math.max(1, Math.trunc(days));
  return {
    startIso: `${utcDay(t - (n - 1) * DAY_MS)}T00:00:00Z`,
    endIso: `${utcDay(t)}T23:59:59Z`,
  };
}

// --- CMR ---------------------------------------------------------------------

/**
 * Query parameters for one HLS product's granule search over a box and window,
 * newest first. For the proxy client: getJson('cmr', '/granules.umm_json', { params }).
 */
export function cmrQuery({ product, box, startIso, endIso, pageSize = CMR_PAGE_SIZE }) {
  const spec = PRODUCTS[product];
  if (!spec?.cmrCollection) throw new TypeError(`No CMR collection for ${product}`);
  const r = validateBox(box);
  if (!r.ok) throw new TypeError(r.message);
  const { west, south, east, north } = r.box;
  const size = Math.max(1, Math.min(2000, Math.trunc(pageSize) || CMR_PAGE_SIZE));
  const deg = (v) => String(Number(v.toFixed(6)));
  return {
    collection_concept_id: spec.cmrCollection,
    bounding_box: [west, south, east, north].map(deg).join(','),
    temporal: `${startIso},${endIso}`,
    sort_key: '-start_date',
    page_size: String(size),
  };
}

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isoOrNull = (v) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null;

function ringOf(points) {
  const ring = points
    .map(([lon, lat]) => [numOrNull(lon), numOrNull(lat)])
    .filter(([lon, lat]) => lon !== null && lat !== null);
  return ring.length >= 3 ? ring : null;
}

function footprintOf(geometry) {
  const poly = geometry?.GPolygons?.[0]?.Boundary?.Points;
  if (Array.isArray(poly)) {
    const ring = ringOf(poly.map((p) => [p?.Longitude, p?.Latitude]));
    if (ring) return ring;
  }
  const r = geometry?.BoundingRectangles?.[0];
  if (!r) return null;
  const w = r.WestBoundingCoordinate;
  const s = r.SouthBoundingCoordinate;
  const e = r.EastBoundingCoordinate;
  const n = r.NorthBoundingCoordinate;
  const ring = ringOf([
    [w, s],
    [e, s],
    [e, n],
    [w, n],
  ]);
  return ring?.length === 4 ? ring : null;
}

/**
 * Parse a CMR granules.umm_json page. Every field is optional upstream; a
 * granule without a parseable start time is dropped.
 * @returns {{ granules: Array<{ id: string, product: string, timeStart: string,
 *   timeEnd: string, cloud: number|null, footprint: number[][]|null }>, hits: number }}
 */
export function parseCmrUmm(json, product) {
  const granules = [];
  for (const item of Array.isArray(json?.items) ? json.items : []) {
    const umm = item?.umm || {};
    const meta = item?.meta || {};
    const range = umm.TemporalExtent?.RangeDateTime || {};
    const timeStart = isoOrNull(range.BeginningDateTime);
    if (!timeStart) continue;
    const cloud = Array.isArray(umm.AdditionalAttributes)
      ? umm.AdditionalAttributes.find((a) => a?.Name === 'CLOUD_COVERAGE')?.Values?.[0]
      : null;
    granules.push({
      id: String(meta['concept-id'] || umm.GranuleUR || meta['native-id'] || ''),
      product,
      timeStart,
      timeEnd: isoOrNull(range.EndingDateTime) || timeStart,
      cloud: numOrNull(cloud),
      footprint: footprintOf(umm.SpatialExtent?.HorizontalSpatialDomain?.Geometry),
    });
  }
  return { granules, hits: numOrNull(json?.hits) ?? granules.length };
}

/**
 * Walk one product's CMR pages, sending each response's CMR-Search-After cursor
 * back, until a short page, no cursor, a repeated cursor or the record cap.
 * `fetchPage(params, cursor, signal)` resolves { json, cursor } (cursor null when
 * the transport cannot see the header: then one page is all there is).
 * @returns {Promise<{ granules: object[], truncated: boolean }>}
 */
export async function fetchCmrPages({
  product,
  params,
  fetchPage,
  signal,
  maxRecords = CMR_MAX_RECORDS,
}) {
  const pageSize = Number(params.page_size) || CMR_PAGE_SIZE;
  const granules = [];
  const seen = new Set();
  let hits = 0;
  let cursor = null;
  for (;;) {
    const res = await fetchPage(params, cursor, signal);
    const page = parseCmrUmm(res?.json, product);
    for (const g of page.granules) {
      if (g.id && seen.has(g.id)) continue;
      if (g.id) seen.add(g.id);
      granules.push(g);
    }
    hits = Math.max(hits, page.hits);
    const next = res?.cursor || null;
    if (
      !next ||
      next === cursor ||
      page.granules.length < pageSize ||
      granules.length >= maxRecords ||
      granules.length >= hits
    )
      break;
    cursor = next;
  }
  return { granules: granules.slice(0, maxRecords), truncated: hits > granules.length };
}

/**
 * A fetchPage for fetchCmrPages that goes through the proxy feed 'cmr': it
 * sends the cursor as a CMR-Search-After request header and reads the next one
 * from the response. (The relay passes neither header yet, so today this walks
 * one page; see proxy/feeds/imagery.js.)
 * @param {{ buildUrl: Function, fetchImpl?: typeof fetch }} deps
 */
export function createCmrFetcher({ buildUrl, fetchImpl = (...a) => fetch(...a) }) {
  return async (params, cursor, signal) => {
    const headers = { accept: 'application/json' };
    if (cursor) headers[CMR_SEARCH_AFTER.toLowerCase()] = cursor;
    const res = await fetchImpl(buildUrl('cmr', '/granules.umm_json', params), {
      headers,
      signal,
    });
    if (!res.ok) throw new Error(`proxy cmr responded ${res.status}`);
    return {
      json: await res.json(),
      cursor: res.headers?.get?.(CMR_SEARCH_AFTER) || null,
    };
  };
}

// --- candidates --------------------------------------------------------------

/** Candidate key: PRODUCT:YYYY-MM-DD. */
export const candidateKey = (product, day) => `${product}:${day}`;

/** Split a candidate key; null when the product is unknown or the day invalid. */
export function parseCandidateKey(key) {
  const m = /^(S30|L30|VIIRS):(\d{4}-\d{2}-\d{2})$/.exec(String(key));
  return m && isValidDay(m[2]) ? { product: m[1], day: m[2] } : null;
}

const cloudOf = (g) => (finite(g?.cloud) ? g.cloud : null);

function buildCandidate(product, day, granules) {
  const clouds = granules.map(cloudOf).filter((v) => v !== null);
  const starts = granules.map((g) => Date.parse(g.timeStart)).filter(Number.isFinite);
  const ends = granules
    .map((g) => Date.parse(g.timeEnd ?? g.timeStart))
    .filter(Number.isFinite);
  return {
    key: candidateKey(product, day),
    product,
    day,
    granules,
    cloud: clouds.length ? { min: Math.min(...clouds), max: Math.max(...clouds) } : null,
    timeRange:
      starts.length && ends.length
        ? {
            start: new Date(Math.min(...starts)).toISOString(),
            end: new Date(Math.max(...ends)).toISOString(),
          }
        : null,
    availability: granules.length ? 'present' : 'empty',
    coverage: 'unknown',
  };
}

/**
 * Merge candidate lists newest day first, then S30, L30, VIIRS; the first
 * occurrence of a key wins.
 */
export function mergeCandidates(lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const c of list || []) if (c?.key && !byKey.has(c.key)) byKey.set(c.key, c);
  }
  return [...byKey.values()].sort((a, b) =>
    a.day !== b.day
      ? a.day < b.day
        ? 1
        : -1
      : PRODUCT_ORDER.indexOf(a.product) - PRODUCT_ORDER.indexOf(b.product),
  );
}

/** One candidate per product and UTC day of timeStart, newest first. */
export function groupGranulesByDay(granules) {
  const buckets = new Map();
  for (const g of Array.isArray(granules) ? granules : []) {
    const day = utcDay(g?.timeStart);
    if (!PRODUCTS[g?.product] || !day) continue;
    const key = candidateKey(g.product, day);
    if (!buckets.has(key)) buckets.set(key, { product: g.product, day, granules: [] });
    buckets.get(key).granules.push(g);
  }
  return mergeCandidates([
    [...buckets.values()].map((b) => buildCandidate(b.product, b.day, b.granules)),
  ]);
}

/**
 * One VIIRS overview candidate per UTC day for the last `days` days, today
 * first. Coverage is full (a global mosaic); availability stays unknown until
 * a snapshot answers.
 */
export function viirsCandidates(today, days = CATALOG_DAYS) {
  const d = utcDay(today);
  if (!d) return [];
  const start = Date.parse(`${d}T00:00:00Z`);
  const out = [];
  for (let i = 0; i < Math.max(0, Math.trunc(days)); i += 1) {
    const day = new Date(start - i * DAY_MS).toISOString().slice(0, 10);
    out.push({
      key: candidateKey('VIIRS', day),
      product: 'VIIRS',
      day,
      granules: [],
      cloud: null,
      timeRange: null,
      availability: 'unknown',
      coverage: 'full',
    });
  }
  return out;
}

function pointInPolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * How much of the box a candidate's granule footprints cover, sampled at the
 * four corners and the centre: 'full', 'partial', or 'unknown' (no footprints).
 */
export function coverageFor(candidate, box) {
  const b = normalizeBox(box);
  const rings = (candidate?.granules || [])
    .map((g) => g?.footprint)
    .filter((r) => Array.isArray(r) && r.length >= 3);
  if (!b || !rings.length) return 'unknown';
  const samples = [
    [b.west, b.south],
    [b.east, b.south],
    [b.east, b.north],
    [b.west, b.north],
    [(b.west + b.east) / 2, (b.south + b.north) / 2],
  ];
  return samples.every(([lon, lat]) => rings.some((r) => pointInPolygon(lon, lat, r)))
    ? 'full'
    : 'partial';
}

/**
 * Search both HLS collections and fold them with the VIIRS days. One product
 * failing still yields the other's days plus an `errors` entry; an invalid box
 * throws a TypeError before any request.
 * @param {{ box: object, fetchPage: Function, now?: number|Date, days?: number,
 *   signal?: AbortSignal, pageSize?: number }} opts
 * @returns {Promise<{ box: object, candidates: object[], truncated: boolean,
 *   errors: Array<{ product: string, message: string }> }>}
 */
export async function searchImagery({
  box,
  fetchPage,
  now = Date.now(),
  days = CATALOG_DAYS,
  signal,
  pageSize = CMR_PAGE_SIZE,
}) {
  const v = validateBox(box);
  if (!v.ok) throw new TypeError(v.message);
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage is required');
  const { startIso, endIso } = catalogWindow(now, days);
  const products = ['S30', 'L30'];
  const settled = await Promise.allSettled(
    products.map((product) =>
      fetchCmrPages({
        product,
        params: cmrQuery({ product, box: v.box, startIso, endIso, pageSize }),
        fetchPage,
        signal,
      }),
    ),
  );
  const granules = [];
  const errors = [];
  let truncated = false;
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      granules.push(...r.value.granules);
      truncated ||= r.value.truncated;
    } else {
      errors.push({
        product: products[i],
        message: String(r.reason?.message || r.reason),
      });
    }
  });
  const hls = groupGranulesByDay(granules).map((c) => ({
    ...c,
    coverage: coverageFor(c, v.box),
  }));
  return {
    box: v.box,
    candidates: mergeCandidates([hls, viirsCandidates(endIso, days)]),
    truncated,
    errors,
  };
}

/**
 * Pick the day to start on. Coverage first: an HLS day covering the whole box
 * beats a newer sliver at its edge. Within a tier the newest day whose granules
 * ALL report cloud <= maxCloud wins ('clear'), else the newest ('cloudy'); only
 * slivers left gives 'partial'; else the newest VIIRS day ('overview').
 * `certain` is false when the catalogue was truncated.
 */
export function rankLatest(
  candidates,
  { maxCloud = MAX_CLOUD_FOR_CLEAR, truncated = false } = {},
) {
  const sorted = mergeCandidates([candidates]);
  const present = (c) => c.availability !== 'empty';
  const hlsDay = (c) =>
    PRODUCTS[c.product] &&
    !PRODUCTS[c.product].overview &&
    present(c) &&
    c.granules.length;
  const covers = (c) => c.coverage !== 'partial';
  const clear = (c) =>
    c.granules.every((g) => {
      const cloud = cloudOf(g);
      return cloud !== null && cloud <= maxCloud;
    });
  const tiers = [
    [(c) => hlsDay(c) && covers(c) && clear(c), 'clear'],
    [(c) => hlsDay(c) && covers(c), 'cloudy'],
    [(c) => hlsDay(c) && clear(c), 'partial'],
    [hlsDay, 'partial'],
    [(c) => c.product === 'VIIRS' && present(c), 'overview'],
  ];
  for (const [match, reason] of tiers) {
    const candidate = sorted.find(match);
    if (candidate) return { candidate, reason, certain: !truncated };
  }
  return { candidate: null, reason: null, certain: !truncated };
}

function hhmm(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * One-line UTC readout for a candidate card, e.g.
 * "Sep 18, 2026 17:12Z · 3 days ago · Sentinel-2 via HLS · 30 m · 12% cloud".
 */
export function formatCandidate(candidate, now = Date.now()) {
  const p = PRODUCTS[candidate?.product];
  if (!p || !isValidDay(candidate?.day)) return '';
  const [y, m, d] = candidate.day.split('-').map(Number);
  let when = `${MONTHS[m - 1]} ${d}, ${y}`;
  if (candidate.timeRange?.start) {
    const a = hhmm(candidate.timeRange.start);
    const b = candidate.timeRange.end ? hhmm(candidate.timeRange.end) : a;
    when += (candidate.granules?.length || 0) > 1 && a !== b ? ` ${a}-${b}Z` : ` ${a}Z`;
  }
  const parts = [when];
  const today = utcDay(now);
  if (today) {
    const delta = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${candidate.day}T00:00:00Z`)) /
        DAY_MS,
    );
    parts.push(delta <= 0 ? 'today' : delta === 1 ? 'yesterday' : `${delta} days ago`);
  }
  parts.push(p.sensor, `${p.resolutionM} m`);
  if (p.overview) parts.push('overview');
  const c = candidate.cloud;
  if (!c) parts.push('cloud unknown');
  else {
    const lo = Math.round(c.min);
    const hi = Math.round(c.max);
    parts.push(lo === hi ? `${lo}% cloud` : `${lo}-${hi}% cloud`);
  }
  return parts.join(' · ');
}

// --- display -----------------------------------------------------------------

/**
 * GIBS tile URL template through the proxy feed 'gibs', with {z}/{y}/{x}
 * placeholders (GIBS puts the row before the column). The template part is
 * appended after buildUrl so its braces are not percent-encoded.
 * @param {(feedId: string, path: string) => string} buildUrl
 */
export function gibsTileTemplate(buildUrl, product, day) {
  const p = PRODUCTS[product];
  if (!p) throw new TypeError(`Unknown imagery product: ${product}`);
  if (!isValidDay(day)) throw new TypeError(`Invalid day: ${day}`);
  const base = buildUrl(
    'gibs',
    `/${p.gibsLayer}/default/${day}/GoogleMapsCompatible_Level${p.maxLevel}`,
  );
  return `${base.replace(/\/+$/, '')}/{z}/{y}/{x}.${p.format}`;
}

/**
 * A raster spec for core/layers/sdk/rasterLayer.js ('xyz' kind, Web Mercator,
 * clipped to the box so no tile outside it is requested). The key includes the
 * box, so a new box with the same day reloads.
 */
export function imageryRasterSpec({ buildUrl, product, day, box }) {
  const v = validateBox(box);
  if (!v.ok) throw new TypeError(v.message);
  const p = PRODUCTS[product];
  if (!p) throw new TypeError(`Unknown imagery product: ${product}`);
  const { west, south, east, north } = v.box;
  return {
    kind: 'xyz',
    url: gibsTileTemplate(buildUrl, product, day),
    rectangle: [west, south, east, north],
    maximumLevel: p.maxLevel,
    credit: IMAGERY_CREDIT,
    label: `${p.label} ${day}`,
    key: `imagery ${product} ${day} ${west},${south},${east},${north}`,
  };
}

/**
 * Worldview Snapshot query for a thumbnail or PNG export of one product-day
 * over the box. EPSG:4326 BBOX order is lat,lon: south,west,north,east.
 */
export function wvsSnapshotParams({
  product,
  day,
  box,
  width = 256,
  height = 256,
  format = 'image/png',
}) {
  const p = PRODUCTS[product];
  const b = normalizeBox(box);
  if (!p) throw new TypeError(`Unknown imagery product: ${product}`);
  if (!b) throw new TypeError('A finite box is required');
  if (!isValidDay(day)) throw new TypeError(`Invalid day: ${day}`);
  const px = (v) => String(Math.max(16, Math.min(2048, Math.round(v))));
  return {
    REQUEST: 'GetSnapshot',
    LAYERS: p.gibsLayer,
    CRS: 'EPSG:4326',
    TIME: day,
    BBOX: [b.south, b.west, b.north, b.east]
      .map((v) => String(Number(v.toFixed(6))))
      .join(','),
    WIDTH: px(width),
    HEIGHT: px(height),
    FORMAT: format === 'image/jpeg' ? 'image/jpeg' : 'image/png',
  };
}

/** Proxy URL of a Worldview snapshot (usable as an <img> src). */
export function wvsSnapshotUrl(buildUrl, opts) {
  return buildUrl('wvs', '/snapshot', wvsSnapshotParams(opts));
}

/**
 * A small Cesium-free controller for the UI: search a box, select a candidate,
 * and hand the raster layer its spec. Until a candidate is selected the raster
 * source returns an 'empty' spec (nothing drawn).
 * @param {{ buildUrl: Function, fetchImpl?: typeof fetch, now?: () => number }} deps
 */
export function createImageryCatalogue({
  buildUrl,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
}) {
  const fetchPage = createCmrFetcher({ buildUrl, fetchImpl });
  const listeners = new Set();
  let result = null;
  let selection = null;
  const changed = () => listeners.forEach((fn) => fn(selection));

  // The raster engine (core/layers/sdk/rasterLayer.js) calls this for its spec
  // and, through .subscribe, reloads as soon as the selection changes. With
  // nothing selected it gets an 'empty' spec, which clears the overlay.
  const rasterSource = async () =>
    selection
      ? imageryRasterSpec({ buildUrl, ...selection })
      : { kind: 'empty', label: 'No imagery selected' };
  rasterSource.subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return {
    /** Search a box; resolves { box, candidates, truncated, errors, start }. */
    async search(box, { signal, days } = {}) {
      const r = await searchImagery({ box, fetchPage, now: now(), days, signal });
      result = { ...r, start: rankLatest(r.candidates, { truncated: r.truncated }) };
      return result;
    },
    get result() {
      return result;
    },
    /** Select a candidate (object or key) over a box (default: the searched box). */
    select(candidate, box = result?.box) {
      const ref =
        typeof candidate === 'string'
          ? parseCandidateKey(candidate)
          : candidate && { product: candidate.product, day: candidate.day };
      if (!ref || !PRODUCTS[ref.product]) throw new TypeError('Unknown candidate');
      const v = validateBox(box);
      if (!v.ok) throw new TypeError(v.message);
      selection = { product: ref.product, day: ref.day, box: v.box };
      changed();
      return selection;
    },
    clear() {
      selection = null;
      changed();
    },
    get selection() {
      return selection;
    },
    /** Raster source for the SDK: the selected spec, or an 'empty' one. */
    rasterSource,
    /** fn(selection) after every select / clear. */
    subscribe: rasterSource.subscribe,
    thumbnailUrl: (candidate, box = result?.box, size = 256) =>
      wvsSnapshotUrl(buildUrl, {
        product: candidate.product,
        day: candidate.day,
        box,
        ...snapshotSize(box, size),
      }),
  };
}

/**
 * Pixel size for a snapshot of the box whose longer side is `size` px. The
 * snapshot is plate carree (EPSG:4326), so the aspect is the box's span in
 * degrees, which keeps the pixels square.
 */
export function snapshotSize(box, size = 256) {
  const b = normalizeBox(box);
  const lon = b ? b.east - b.west : 0;
  const lat = b ? b.north - b.south : 0;
  if (!(lon > 0 && lat > 0)) return { width: size, height: size };
  const clamp = (v) => Math.max(16, Math.min(2048, Math.round(v)));
  return lon >= lat
    ? { width: clamp(size), height: clamp((size * lat) / lon) }
    : { width: clamp((size * lon) / lat), height: clamp(size) };
}
