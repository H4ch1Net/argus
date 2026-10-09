// Feed registry, street level: TomTom Flow Segment Data (the simulated
// traffic's live speeds and the flow readout) and Mapillary street photos.
// Same Feed shape as proxy/feeds.js (see its typedefs); spread into that list.
//
// Neither could be called from the build environment (no TomTom key, no
// Mapillary token), so both are "per the provider's documentation, not
// live-tested here". The client side lives in core (Cesium-free):
// core/layers/simtraffic/flow.js and core/layers/streetphotos/parse.js;
// proxy/test/streetFeeds.test.js checks that what they build passes the pins.

import { UA, exactPath, MINUTE, HOUR } from './common.js';
import { pinnedQuery } from './earth.js';

/** "lat,lon" with at most 5 decimals, in range. */
export function flowPointOk(v) {
  if (typeof v !== 'string' || v.length > 32) return false;
  const m = /^(-?\d{1,2}(?:\.\d{1,5})?),(-?\d{1,3}(?:\.\d{1,5})?)$/.exec(v);
  if (!m) return false;
  return Math.abs(Number(m[1])) <= 90 && Math.abs(Number(m[2])) <= 180;
}

// Exactly the fields core asks for (core/layers/streetphotos/parse.js
// MAPILLARY_FIELDS, kept equal by the test). None names a person: the
// creator fields are never requested.
export const MAPILLARY_FIELDS =
  'id,captured_at,compass_angle,geometry,thumb_256_url,thumb_1024_url,is_pano';

const NUM6 = /^-?\d{1,3}(?:\.\d{1,6})?$/;

/** "minLon,minLat,maxLon,maxLat", in range and no bigger than 0.02 x 0.02 degrees. */
export function mapillaryBboxOk(v) {
  if (typeof v !== 'string' || v.length > 80) return false;
  const parts = v.split(',');
  if (parts.length !== 4 || !parts.every((p) => NUM6.test(p))) return false;
  const [lomin, lamin, lomax, lamax] = parts.map(Number);
  if (lomin < -180 || lomax > 180 || lamin < -90 || lamax > 90) return false;
  if (lomax <= lomin || lamax <= lamin) return false;
  return lomax - lomin <= 0.0200001 && lamax - lamin <= 0.0200001;
}

// The query parameters of a signed Mapillary thumbnail URL on Meta's image
// CDN (stp, ccb, oh, oe, _nc_*...). Values are short tokens; anything else
// (a second path, a scheme) is refused.
const THUMB_PARAM = /^(stp|ccb|oh|oe|efg|edm|_nc_[a-z]{2,8})$/;
const THUMB_VALUE = /^[A-Za-z0-9_.,=%-]{1,512}$/;
export function thumbQueryOk(q) {
  const keys = [...q.keys()];
  if (keys.length > 12 || new Set(keys).size !== keys.length) return false;
  for (const [k, v] of q) if (!THUMB_PARAM.test(k) || !THUMB_VALUE.test(v)) return false;
  return true;
}

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    // TomTom Traffic Flow Segment Data (Traffic API v4): current and free-flow
    // speed of the road segment nearest a point, with the segment's geometry.
    // The simulated traffic samples a few points per view (bigger roads first,
    // each answer kept five minutes) and the VIEW flow readout asks for the road
    // under the middle of the view. Same free TOMTOM_API_KEY as the flow tiles
    // and incidents, injected as ?key=. TomTom's free tier allows about 2,500
    // non-tile requests a day across incidents and this feed: incidents keep
    // 2,000, this feed is capped at 450 a day and 30 a minute, answers are
    // cached 2 minutes per point, and a stale one stands in for 10 minutes.
    // Pinned: the absolute style, four zoom levels, JSON, a point, km/h.
    // Per the provider's documentation, not live-tested here.
    id: 'tomtom-flowseg',
    baseUrl: 'https://api.tomtom.com/traffic/services/4',
    methods: ['GET'],
    allowPaths: [
      /^\/traffic\/services\/4\/flowSegmentData\/absolute\/(10|12|14|16)\/json$/,
    ],
    allowQuery: pinnedQuery({ point: flowPointOk }, { unit: 'KMPH', openLr: 'false' }),
    inject: [{ secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' }],
    headers: UA,
    governor: {
      ratePerMinute: 30,
      creditBudget: 450,
      creditWindowMs: 24 * HOUR,
      creditCost: 1,
    },
    cache: { ttlMs: 2 * MINUTE, staleMs: 10 * MINUTE, maxEntries: 128 },
  },
  {
    // Mapillary street-level photos (API v4 on the Graph API): images in a
    // small box with their capture time, compass angle, position and signed
    // thumbnail URLs. Needs a client token (MAPILLARY_TOKEN, "MLY|..."), sent
    // as the documented "Authorization: OAuth <token>" header so it never sits
    // in a URL; the client may never send one. Images are CC BY-SA 4.0 and
    // every card credits Mapillary with a link to the image. Pinned to one
    // query shape: a box of at most 0.02 x 0.02 degrees (Mapillary refuses big
    // boxes), the one field list (no creator fields), a fixed set of limits.
    // Cached 30 minutes per box (the client snaps boxes to a grid).
    // Per the provider's documentation, not live-tested here.
    id: 'mapillary',
    baseUrl: 'https://graph.mapillary.com',
    methods: ['GET'],
    allowPaths: [exactPath('/images')],
    allowQuery: pinnedQuery(
      { bbox: mapillaryBboxOk, fields: MAPILLARY_FIELDS },
      { limit: ['50', '100', '200'] },
    ),
    inject: [
      {
        secret: 'MAPILLARY_TOKEN',
        as: 'header',
        name: 'Authorization',
        template: 'OAuth {value}',
      },
    ],
    headers: UA,
    governor: { ratePerMinute: 30, creditBudget: 5000, creditWindowMs: 24 * HOUR },
    cache: { ttlMs: 30 * MINUTE, staleMs: 24 * HOUR, maxEntries: 64 },
  },
  {
    // Mapillary thumbnails: the signed URLs the API returns point at Meta's
    // image CDN (scontent-<edge>.xx.fbcdn.net/m1/v/t6/<token>?...). The client
    // rewrites them onto this one pinned host (core/layers/streetphotos/
    // parse.js mapillaryThumbPath), so the browser never fetches a third-party
    // host and the proxy reaches only image paths there. Image bodies only.
    // MAPILLARY_IMAGE_URL may name another edge host if the generic one
    // refuses a URL signed for a regional edge (untested: no token here).
    // Per the provider's documentation, not live-tested here.
    id: 'mapillary-img',
    baseUrl: 'https://scontent.xx.fbcdn.net',
    baseUrlEnv: 'MAPILLARY_IMAGE_URL',
    methods: ['GET'],
    allowPaths: [/^\/m1\/v\/t\d{1,2}\/[A-Za-z0-9_.-]{8,1024}$/],
    allowQuery: thumbQueryOk,
    imageOnly: true,
    headers: UA,
    governor: { ratePerMinute: 120 },
    cache: { ttlMs: 6 * HOUR, staleMs: 24 * HOUR, maxEntries: 48 },
  },
];
