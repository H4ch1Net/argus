// Pure parsers for the public webcam sources. Each turns one payload into
// webcam records:
//   { id, source, name, lat, lon, category, tags, place, provider, operator,
//     image: { feedId, path, params? } | null, imageKind, pageUrl, pageLabel,
//     extraLinks, updated, description, streaming, rank, license, licenseUrl,
//     credit }
// Shared by every shell (the terminal lists webcams too).
//
// Every still is pinned: a parser accepts only its provider's image host and a
// path shape that provider's image-only proxy feed also allows
// (proxy/feeds/webcams.js), so no payload field can steer the proxy anywhere
// else. Links out (a webcam's page on its provider's site) are https only and
// open in a new tab; they are never fetched by Argus.
//
// Sources, per each provider's documentation (not live-tested here):
// - Windy Webcams API v3 (https://api.windy.com/webcams/docs)
// - NPS Data API, /webcams (https://www.nps.gov/subjects/developer/api-documentation.htm)
// - NASA EPIC, /api/natural (https://epic.gsfc.nasa.gov/about/api)
// - a bundled catalogue of space-observatory stills (./data/observatories.js)
//
// GUARDRAIL: stills are shown as published, on request (a card). Nothing in
// this project analyses them: no detection, no tracking, no reading of any kind.

import { categoryFor } from './categories.js';

const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const text = (v, max = 140) =>
  typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null;
const list = (v) => (Array.isArray(v) ? v : []);
const located = (lat, lon) =>
  lat !== null &&
  lon !== null &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180 &&
  Boolean(lat || lon);

/** An https URL with no credentials, or null. */
export function httpsUrl(v) {
  try {
    const u = new URL(String(v ?? '').trim());
    return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u : null;
  } catch {
    return null;
  }
}
const link = (v) => httpsUrl(v)?.href ?? null;

/** Plain text from a field that may carry HTML (NPS descriptions do). */
const plain = (v, max = 280) =>
  text(
    String(v ?? '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&[a-z#0-9]{1,10};/gi, ' '),
    max,
  );

// --- Windy ------------------------------------------------------------------

/**
 * Windy's still hosts, each with its own image-only proxy feed. v3 image links
 * are tokenized and expire (about 10 minutes on the free tier), so the query is
 * kept as is, within the bounds the proxy feed also checks.
 */
export const WINDY_IMAGE_FEEDS = Object.freeze({
  'images-webcams.windy.com': 'windy-img',
  'imgproxy.windy.com': 'windy-imgproxy',
});
export const WINDY_IMAGE_PATH = /^\/[A-Za-z0-9_/.:-]{1,300}\.(?:jpe?g|png|webp)$/i;
const QUERY_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/;
const QUERY_VALUE = /^[A-Za-z0-9_.~:+/=-]{0,512}$/;
export const MAX_IMAGE_QUERY_PARAMS = 4;

/** A tokenized still's query, if every pair is plain and there are few. */
export function boundedImageQuery(searchParams) {
  const pairs = [...searchParams];
  if (pairs.length > MAX_IMAGE_QUERY_PARAMS) return null;
  const keys = new Set();
  const params = {};
  for (const [k, v] of pairs) {
    if (!QUERY_KEY.test(k) || !QUERY_VALUE.test(v) || keys.has(k)) return null;
    keys.add(k);
    params[k] = v;
  }
  return params;
}

/** A Windy still URL -> { feedId, path, params? } on its image feed, or null. */
export function windyImage(raw) {
  const u = httpsUrl(raw);
  const feedId = u && WINDY_IMAGE_FEEDS[u.hostname.toLowerCase()];
  if (!feedId || !WINDY_IMAGE_PATH.test(u.pathname)) return null;
  const params = boundedImageQuery(u.searchParams);
  if (!params) return null;
  return Object.keys(params).length
    ? { feedId, path: u.pathname, params }
    : { feedId, path: u.pathname };
}

const windyPage = (raw, id) => {
  const u = httpsUrl(raw);
  return u && /^(www\.)?windy\.com$/i.test(u.hostname)
    ? u.href
    : `https://www.windy.com/webcams/${id}`;
};

/**
 * Windy Webcams API v3, GET /webcams with include=categories,images,location,
 * player,urls: { total, webcams: [{ webcamId, title, status, viewCount,
 * lastUpdatedOn, categories: [{ id, name }], images: { current: { icon,
 * thumbnail, preview } }, location: { city, region, country, latitude,
 * longitude }, player: { day, live, ... }, urls: { detail, provider } }] }.
 * Only active webcams with a position.
 */
export function parseWindy(payload) {
  const out = [];
  const seen = new Set();
  for (const w of list(payload?.webcams)) {
    const id = String(w?.webcamId ?? w?.id ?? '').trim();
    if (!/^\d{1,14}$/.test(id) || seen.has(id)) continue;
    const status = String(w?.status ?? 'active').toLowerCase();
    if (status !== 'active') continue;
    const lat = num(w?.location?.latitude);
    const lon = num(w?.location?.longitude);
    if (!located(lat, lon)) continue;
    seen.add(id);
    const tags = list(w?.categories)
      .map((c) => String(c?.id ?? c ?? '').toLowerCase())
      .filter((c) => /^[a-z_-]{1,30}$/.test(c));
    const name = text(w?.title, 140) || `Windy webcam ${id}`;
    const cur = w?.images?.current ?? {};
    const image = windyImage(cur.preview) ?? windyImage(cur.thumbnail);
    const loc = w?.location ?? {};
    const place = [text(loc.city, 60), text(loc.region, 60), text(loc.country, 60)]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ');
    const extraLinks = [];
    const operator = link(w?.urls?.provider);
    if (operator) extraLinks.push({ label: 'Webcam operator', url: operator });
    const player = link(w?.player?.day ?? w?.player?.live);
    if (player) extraLinks.push({ label: 'Timelapse on windy.com', url: player });
    out.push({
      id: `windy-${id}`,
      source: 'windy',
      name,
      lat,
      lon,
      category: categoryFor({ windy: tags, text: name }),
      tags,
      place: place || null,
      provider: 'Windy.com',
      operator: null,
      image,
      imageKind: 'live',
      pageUrl: windyPage(w?.urls?.detail, id),
      pageLabel: 'This webcam on windy.com',
      extraLinks,
      updated: text(w?.lastUpdatedOn, 40),
      description: null,
      streaming: null,
      rank: num(w?.viewCount) ?? 0,
      license: 'Webcams provided by windy.com',
      licenseUrl: 'https://www.windy.com/webcams',
      credit: 'Webcams provided by windy.com',
    });
  }
  return out;
}

/** The total Windy reports for a query (it pages at 50), or null. */
export const windyTotal = (payload) => num(payload?.total);

// --- National Park Service ---------------------------------------------------

export const NPS_IMAGE_PATH =
  /^\/common\/uploads\/[A-Za-z0-9_/.-]{1,240}\.(?:jpe?g|png|gif|webp)$/i;

/** An NPS image URL -> { feedId, path } on nps-img, or null (query dropped). */
export function npsImage(raw) {
  const u = httpsUrl(raw);
  if (!u || u.hostname.toLowerCase() !== 'www.nps.gov') return null;
  return NPS_IMAGE_PATH.test(u.pathname) ? { feedId: 'nps-img', path: u.pathname } : null;
}

/**
 * NPS Data API, GET /webcams: { total, data: [{ id, url, title, description,
 * images: [{ url, altText, credit }], relatedParks: [{ fullName, parkCode,
 * states }], status, statusMessage, isStreaming, latitude, longitude, credit }] }.
 * Active webcams with a position only (many listings carry none). Each is a
 * park camera; a title naming a wildlife camera (a bear cam, a nest cam) is
 * filed under wildlife.
 */
export function parseNps(payload) {
  const out = [];
  const seen = new Set();
  for (const d of list(payload?.data)) {
    const id = String(d?.id ?? '').trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id) || seen.has(id)) continue;
    const status = String(d?.status ?? 'active').toLowerCase();
    if (status && status !== 'active') continue;
    const lat = num(d?.latitude);
    const lon = num(d?.longitude);
    if (!located(lat, lon)) continue;
    seen.add(id);
    const name = text(d?.title, 140) || `NPS webcam ${id.slice(0, 8)}`;
    const parks = list(d?.relatedParks)
      .map((p) => text(p?.fullName, 80))
      .filter(Boolean);
    const img = list(d?.images).find((i) => npsImage(i?.url));
    const imageCredit = text(img?.credit, 120);
    out.push({
      id: `nps-${id.toLowerCase()}`,
      source: 'nps',
      name,
      lat,
      lon,
      category: categoryFor({ base: ['park'], text: name }),
      tags: ['park'],
      place: parks.join(', ') || null,
      provider: 'National Park Service',
      operator: parks[0] ?? null,
      image: img ? npsImage(img.url) : null,
      imageKind: 'reference',
      pageUrl: link(d?.url),
      pageLabel: 'Webcam page (live view)',
      extraLinks: [],
      updated: null,
      description: plain(d?.description),
      streaming: typeof d?.isStreaming === 'boolean' ? d.isStreaming : null,
      rank: 1,
      license:
        'National Park Service (US federal data; images may carry their own credit)',
      licenseUrl: 'https://www.nps.gov/aboutus/disclaimer.htm',
      credit: imageCredit || text(d?.credit, 120),
    });
  }
  return out;
}

// --- NASA EPIC ---------------------------------------------------------------

const EPIC_IMAGE = /^epic_1b_(\d{4})(\d{2})(\d{2})\d{6}$/;

/** EPIC archive paths for one natural-colour image name, or null. */
export function epicImagePaths(image) {
  const m = EPIC_IMAGE.exec(String(image ?? ''));
  if (!m) return null;
  const day = `/archive/natural/${m[1]}/${m[2]}/${m[3]}`;
  return {
    thumb: `${day}/thumbs/${image}.jpg`,
    jpg: `${day}/jpg/${image}.jpg`,
    png: `${day}/png/${image}.png`,
  };
}

/**
 * NASA EPIC, GET /api/natural (the most recent day): [{ identifier, caption,
 * image, date: "2026-10-07 00:31:45", centroid_coordinates: { lat, lon } }].
 * Each image is placed at its centroid, the point on Earth it looks straight down at.
 */
export function parseEpic(payload) {
  const out = [];
  const seen = new Set();
  for (const r of list(payload)) {
    const paths = epicImagePaths(r?.image);
    if (!paths || seen.has(r.image)) continue;
    const lat = num(r?.centroid_coordinates?.lat);
    const lon = num(r?.centroid_coordinates?.lon);
    if (!located(lat, lon)) continue;
    seen.add(r.image);
    const date = text(r?.date, 25);
    out.push({
      id: `epic-${r.image.slice(8)}`,
      source: 'epic',
      name: `Earth from DSCOVR (EPIC), ${date ? `${date} UTC` : r.image.slice(8)}`,
      lat,
      lon,
      category: 'space',
      tags: ['space'],
      place: 'Centre of the image (sub-spacecraft view)',
      provider: 'NASA EPIC (DSCOVR)',
      operator: null,
      image: { feedId: 'epic-img', path: paths.thumb },
      imageKind: 'archive',
      pageUrl: 'https://epic.gsfc.nasa.gov/',
      pageLabel: 'EPIC gallery',
      extraLinks: [],
      // The full-size JPEG is a proxy link built by the source (never preloaded).
      fullImage: { feedId: 'epic-img', path: paths.jpg },
      updated: date ? `${date.replace(' ', 'T')}Z` : null,
      description: text(r?.caption, 240),
      streaming: null,
      rank: 1,
      license: 'NASA EPIC Team (public domain)',
      licenseUrl: 'https://epic.gsfc.nasa.gov/about',
      credit: 'NASA EPIC Team',
    });
  }
  return out;
}

// --- Bundled observatory catalogue -------------------------------------------

/** The still each observatory image feed allows, by feed id. */
export const OBSERVATORY_IMAGE_PATHS = Object.freeze({
  'sdo-img': /^\/assets\/img\/latest\/latest_(?:512|1024|2048)_[A-Z0-9]{3,8}\.jpg$/,
  'soho-img':
    /^\/data\/realtime\/(?:c2|c3|eit_(?:171|195|284|304)|hmi_igr)\/(?:512|1024)\/latest\.jpg$/,
});

/** data/observatories.js rows -> webcam records (pinned to their image feeds). */
export function parseObservatories(rows) {
  const out = [];
  for (const c of list(rows)) {
    if (!/^[a-z0-9-]{1,40}$/.test(String(c?.id))) continue;
    const pin = OBSERVATORY_IMAGE_PATHS[c?.feedId];
    if (!pin || !pin.test(String(c?.path))) continue;
    const lat = num(c?.lat);
    const lon = num(c?.lon);
    if (!located(lat, lon)) continue;
    out.push({
      id: `obs-${c.id}`,
      source: 'observatory',
      name: text(c.name) || c.id,
      lat,
      lon,
      category: 'observatory',
      tags: ['observatory'],
      place: text(c.place, 120),
      provider: text(c.provider, 80) || 'Observatory',
      operator: null,
      image: { feedId: c.feedId, path: c.path },
      imageKind: 'live',
      pageUrl: link(c.pageUrl),
      pageLabel: 'Mission page',
      extraLinks: [],
      updated: null,
      description: text(c.note, 240),
      streaming: null,
      rank: 1,
      license: text(c.license, 160) || '',
      licenseUrl: link(c.licenseUrl),
      credit: text(c.credit, 160),
    });
  }
  return out;
}
