// Share links: the view as a URL hash, v=1. Pure (no Cesium, no DOM): the
// shells read location.hash on load and write it (debounced, replaceState) as
// the view changes; the phone hands the URL to navigator.share.
//
//   #v=1&lat=48.85660&lon=2.35220&alt=150000&heading=12.5&pitch=-35
//    &layers=flights,quakes&sensor=nvg&imagery=satellite&terrain=flat
//    &labels=places.1,entities.0&track=flights:3c6444
//
// Every field has a strict grammar and decoding fails closed: an unknown key,
// a repeated key, a malformed or out-of-range value, or an over-long hash
// rejects the WHOLE link (null), never a salvaged part of it. Camera angles
// are degrees (Cesium takes radians: convert in the shell).
//
// Adapted from gods-eye-view src/sharelink.js and src/data/layerState.js (MIT).
// Local only: nothing here is stored or sent anywhere.

export const SHARE_VERSION = 1;
export const SHARE_MAX_LENGTH = 4096;
export const SHARE_MAX_LAYERS = 64;
export const SHARE_MAX_LABELS = 16;
/** Camera altitude bounds in metres (street level to well past GEO). */
export const SHARE_ALT_MIN_M = 1;
export const SHARE_ALT_MAX_M = 100_000_000;

/** A layer key, sensor mode, imagery id, terrain id or label key. */
const KEY = /^[a-z][a-z0-9_-]{0,31}$/;
/** An entity id inside a layer: transponder hex (TIS-B ~hex too), NORAD number, USGS id, radio:<uuid>. */
const ENTITY_ID = /^[A-Za-z0-9~][A-Za-z0-9._~:-]{0,63}$/;
/** Plain decimal only: no exponent, no hex, no Infinity, no leading '+'. */
const DECIMAL = /^-?\d{1,9}(\.\d{1,7})?$/;

const FIELDS = new Set([
  'v',
  'lat',
  'lon',
  'alt',
  'heading',
  'pitch',
  'layers',
  'sensor',
  'imagery',
  'terrain',
  'labels',
  'track',
]);
const CAMERA_FIELDS = ['lat', 'lon', 'alt', 'heading', 'pitch'];

/**
 * @typedef {Object} ShareState
 * @property {{ lat: number, lon: number, alt: number, heading?: number, pitch?: number }} [camera]
 * @property {string[]} [layers]                 enabled layer keys (absent: leave layers as they are)
 * @property {string} [sensor]                   sensor mode id, e.g. 'none' | 'nvg' | 'flir'
 * @property {string} [imagery]                  base imagery id, e.g. 'base' | 'satellite' | 'streets'
 * @property {string} [terrain]                  terrain id, e.g. 'flat' | 'terrain' | 'photoreal'
 * @property {Record<string, boolean>} [labels]  label toggles by key
 * @property {{ layer: string, id: string }} [track]  the tracked entity
 *
 * @typedef {Object} ShareAllow  optional allowlists; a value outside one rejects the link
 * @property {Iterable<string>} [layerKeys]
 * @property {Iterable<string>} [sensorModes]
 * @property {Iterable<string>} [imageryIds]
 * @property {Iterable<string>} [terrainIds]
 * @property {Iterable<string>} [labelKeys]
 */

const asSet = (it) => (it ? new Set(it) : null);
const allowed = (set, v) => !set || set.has(v);

function num(raw, min, max) {
  if (typeof raw !== 'string' || !DECIMAL.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** "a,b,c" -> ['a','b','c'] when every item is a KEY and none repeats; '' -> []; else null. */
function keyList(raw, max) {
  if (raw === '') return [];
  const items = raw.split(',');
  if (items.length > max || new Set(items).size !== items.length) return null;
  return items.every((k) => KEY.test(k)) ? items : null;
}

function parseTrack(raw) {
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  const layer = raw.slice(0, i);
  const id = raw.slice(i + 1);
  return KEY.test(layer) && ENTITY_ID.test(id) ? { layer, id } : null;
}

/**
 * Decode a share hash ('#v=1&...' or 'v=1&...'). Returns the state, or null
 * when the hash is not a v=1 share link or anything in it is malformed.
 * @param {string} hash
 * @param {ShareAllow} [allow]
 * @returns {(ShareState & { version: 1 }) | null}
 */
export function decodeShareHash(hash, allow = {}) {
  if (typeof hash !== 'string') return null;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!body || body.length > SHARE_MAX_LENGTH) return null;

  const params = new Map();
  for (const part of body.split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) return null;
    let key;
    let value;
    try {
      key = decodeURIComponent(part.slice(0, eq));
      value = decodeURIComponent(part.slice(eq + 1));
    } catch {
      return null;
    }
    if (!FIELDS.has(key) || params.has(key)) return null;
    params.set(key, value);
  }
  if (params.get('v') !== String(SHARE_VERSION)) return null;

  const out = { version: SHARE_VERSION };

  if (CAMERA_FIELDS.some((k) => params.has(k))) {
    const lat = num(params.get('lat'), -90, 90);
    const lon = num(params.get('lon'), -180, 180);
    const alt = num(params.get('alt'), SHARE_ALT_MIN_M, SHARE_ALT_MAX_M);
    if (lat === null || lon === null || alt === null) return null;
    const camera = { lat, lon, alt };
    if (params.has('heading')) {
      const h = num(params.get('heading'), 0, 360);
      if (h === null) return null;
      camera.heading = h === 360 ? 0 : h;
    }
    if (params.has('pitch')) {
      const p = num(params.get('pitch'), -90, 90);
      if (p === null) return null;
      camera.pitch = p;
    }
    out.camera = camera;
  }

  if (params.has('layers')) {
    const layers = keyList(params.get('layers'), SHARE_MAX_LAYERS);
    const set = asSet(allow.layerKeys);
    if (!layers || !layers.every((k) => allowed(set, k))) return null;
    out.layers = layers;
  }

  for (const [field, allowKey] of [
    ['sensor', 'sensorModes'],
    ['imagery', 'imageryIds'],
    ['terrain', 'terrainIds'],
  ]) {
    if (!params.has(field)) continue;
    const v = params.get(field);
    if (!KEY.test(v) || !allowed(asSet(allow[allowKey]), v)) return null;
    out[field] = v;
  }

  if (params.has('labels')) {
    const raw = params.get('labels');
    const items = raw === '' ? [] : raw.split(',');
    if (items.length > SHARE_MAX_LABELS) return null;
    const set = asSet(allow.labelKeys);
    const labels = {};
    for (const item of items) {
      const m = /^(.+)\.([01])$/.exec(item);
      if (!m || !KEY.test(m[1]) || m[1] in labels || !allowed(set, m[1])) return null;
      labels[m[1]] = m[2] === '1';
    }
    out.labels = labels;
  }

  if (params.has('track')) {
    const track = parseTrack(params.get('track'));
    if (!track || !allowed(asSet(allow.layerKeys), track.layer)) return null;
    out.track = track;
  }

  return out;
}

const fixed = (n, digits) => String(Number(n.toFixed(digits)));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function wrapLon(lon) {
  if (lon >= -180 && lon <= 180) return lon;
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Encode a state as '#v=1&...'. Values that do not fit their grammar are left
 * out rather than written (a bad sensor id never breaks the camera link);
 * numbers are clamped or wrapped into range and rounded (lat/lon to 5 decimals,
 * about a metre; altitude to the metre; angles to 0.1 degree).
 * @param {ShareState} state
 * @returns {string}
 */
export function encodeShareHash(state = {}) {
  const parts = [`v=${SHARE_VERSION}`];
  const c = state.camera;
  const finite = (n) => typeof n === 'number' && Number.isFinite(n);
  if (c && finite(c.lat) && finite(c.lon) && finite(c.alt)) {
    parts.push(`lat=${fixed(clamp(c.lat, -90, 90), 5)}`);
    parts.push(`lon=${fixed(wrapLon(c.lon), 5)}`);
    parts.push(`alt=${Math.round(clamp(c.alt, SHARE_ALT_MIN_M, SHARE_ALT_MAX_M))}`);
    if (finite(c.heading)) {
      const h = Number((((c.heading % 360) + 360) % 360).toFixed(1));
      parts.push(`heading=${h === 360 ? 0 : h}`);
    }
    if (finite(c.pitch)) parts.push(`pitch=${fixed(clamp(c.pitch, -90, 90), 1)}`);
  }
  if (Array.isArray(state.layers)) {
    const keys = [...new Set(state.layers.filter((k) => KEY.test(String(k))))];
    parts.push(`layers=${keys.slice(0, SHARE_MAX_LAYERS).join(',')}`);
  }
  for (const field of ['sensor', 'imagery', 'terrain']) {
    if (typeof state[field] === 'string' && KEY.test(state[field]))
      parts.push(`${field}=${state[field]}`);
  }
  if (state.labels && typeof state.labels === 'object') {
    const items = Object.entries(state.labels)
      .filter(([k]) => KEY.test(k))
      .slice(0, SHARE_MAX_LABELS)
      .map(([k, on]) => `${k}.${on ? 1 : 0}`);
    parts.push(`labels=${items.join(',')}`);
  }
  const t = state.track;
  if (t && KEY.test(String(t.layer)) && ENTITY_ID.test(String(t.id)))
    parts.push(`track=${t.layer}:${t.id}`);
  return `#${parts.join('&')}`;
}
