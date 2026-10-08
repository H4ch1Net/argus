// Scenes: captured views played back in order, each flown to and then held.
// Pure (no Cesium, no DOM): storage is injected, so the terminal shell and the
// tests can use it too. Local only: scenes live in this browser's storage or in
// a JSON file the user exports; nothing here is uploaded anywhere.
//
//   { v: 1, name: 'Paris', shots: [{
//       camera: { lon, lat, alt, heading, pitch, roll },   degrees, metres
//       layers: ['flights', 'quakes'],                      enabled layer keys
//       look: 'nvg',                                        sensor mode (optional)
//       target: { layer: 'flights', id: '3c6444' },         selected contact (optional)
//       holdMs: 4000, flyMs: 3000, caption: 'Arrival' }] }   caption optional
//
// Field names follow the share link (core/share/state.js): the camera is the
// share camera plus roll, `look` is the share link's `sensor` and `target` is
// its `track`, so one converts to the other (shotFromShareState and
// shareStateFromShot below).
//
// Validation fails closed but salvages: a field that is malformed is stripped
// (or defaulted), a number out of range is clamped (longitude wrapped), a shot
// with no usable camera is dropped, and a scene with no usable shot is null.
// Nothing is coerced from strings and no key of the input is copied blindly.
//
// Adapted from gods-eye-view src/director/ (document, timeline, playback) (MIT).

import { SHARE_ALT_MIN_M, SHARE_ALT_MAX_M, SHARE_MAX_LAYERS } from './state.js';

export const SCENE_VERSION = 1;
export const SCENE_MAX_SHOTS = 64;
export const SCENE_MAX_NAME = 60;
export const SCENE_MAX_CAPTION = 120;
export const SCENE_MAX_LAYERS = SHARE_MAX_LAYERS;
export const SCENE_MAX_BYTES = 256 * 1024;
export const SCENE_HOLD_MAX_MS = 120_000;
export const SCENE_FLY_MAX_MS = 60_000;
export const SHOT_DEFAULT_HOLD_MS = 4000;
export const SHOT_DEFAULT_FLY_MS = 3000;
/** Pitch when a shot has none: straight down, as the share link restores it. */
export const SHOT_DEFAULT_PITCH = -90;
/** How many scenes the local store keeps (it refuses more, never evicts). */
export const SCENE_STORE_MAX = 32;
export const SCENE_STORAGE_KEY = 'argus.scenes.v1';

/** A layer key as scenes accept it (stricter than the share link's). */
const LAYER = /^[a-z0-9]{1,24}$/;
/** A sensor mode id, as the share link's sensor field. */
const LOOK = /^[a-z][a-z0-9_-]{0,31}$/;
/** An entity id inside a layer, as the share link's track id. */
const ENTITY_ID = /^[A-Za-z0-9~][A-Za-z0-9._~:-]{0,63}$/;
/** Bidirectional overrides and isolates: they can reorder how a name reads. */
const BIDI = /[‪-‮⁦-⁩]/g;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n, digits) => Number(n.toFixed(digits)) || 0; // || 0: no -0
const wrap360 = (n) => ((n % 360) + 360) % 360;
const wrap180 = (n) => (n >= -180 && n <= 180 ? n : wrap360(n + 180) - 180);
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * One line of user text: control characters and bidi overrides removed,
 * whitespace collapsed, trimmed and capped. Not a string: ''.
 * @param {unknown} raw
 * @param {number} max
 */
export function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (const ch of raw.replace(BIDI, '')) {
    const c = ch.codePointAt(0);
    out += c < 32 || (c >= 127 && c < 160) ? ' ' : ch; // C0, DEL, C1
  }
  return [...out.replace(/\s+/g, ' ').trim()].slice(0, max).join('').trim();
}

/** A scene name: one line, at most SCENE_MAX_NAME characters ('' if none). */
export const cleanName = (raw) => cleanText(raw, SCENE_MAX_NAME);

function cleanCamera(c) {
  if (!isObj(c) || !isNum(c.lat) || !isNum(c.lon) || !isNum(c.alt)) return null;
  return {
    lon: round(wrap180(c.lon), 6),
    lat: round(clamp(c.lat, -90, 90), 6),
    alt: round(clamp(c.alt, SHARE_ALT_MIN_M, SHARE_ALT_MAX_M), 1),
    heading: isNum(c.heading) ? round(wrap360(c.heading), 2) % 360 : 0,
    pitch: isNum(c.pitch) ? round(clamp(c.pitch, -90, 90), 2) : SHOT_DEFAULT_PITCH,
    roll: isNum(c.roll) ? round(wrap180(c.roll), 2) : 0,
  };
}

function cleanLayers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const k of list) {
    if (out.length >= SCENE_MAX_LAYERS) break;
    if (typeof k === 'string' && LAYER.test(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

const cleanMs = (v, max, fallback) =>
  isNum(v) ? Math.round(clamp(v, 0, max)) : fallback;

/**
 * One shot, cleaned (see the header). Null when it has no usable camera.
 * @param {unknown} raw
 * @returns {object|null}
 */
export function validateShot(raw) {
  try {
    return cleanShot(raw);
  } catch {
    return null; // a throwing getter or a proxy: nothing usable
  }
}

function cleanShot(raw) {
  if (!isObj(raw)) return null;
  const camera = cleanCamera(raw.camera);
  if (!camera) return null;
  const shot = {
    camera,
    layers: cleanLayers(raw.layers),
    holdMs: cleanMs(raw.holdMs, SCENE_HOLD_MAX_MS, SHOT_DEFAULT_HOLD_MS),
    flyMs: cleanMs(raw.flyMs, SCENE_FLY_MAX_MS, SHOT_DEFAULT_FLY_MS),
  };
  if (typeof raw.look === 'string' && LOOK.test(raw.look)) shot.look = raw.look;
  const t = raw.target;
  if (
    isObj(t) &&
    typeof t.layer === 'string' &&
    LAYER.test(t.layer) &&
    typeof t.id === 'string' &&
    ENTITY_ID.test(t.id)
  )
    shot.target = { layer: t.layer, id: t.id };
  const caption = cleanText(raw.caption, SCENE_MAX_CAPTION);
  if (caption) shot.caption = caption;
  return shot;
}

/**
 * A scene, cleaned: a fresh object built only from the known fields (the input
 * is never returned or mutated). Null when the input is not a v=1 scene object
 * or keeps no usable shot. A missing name becomes 'UNTITLED'.
 * @param {unknown} obj
 * @returns {{ v: 1, name: string, shots: object[] } | null}
 */
export function validateScene(obj) {
  try {
    if (!isObj(obj) || !Array.isArray(obj.shots)) return null;
    if (Object.hasOwn(obj, 'v') && obj.v !== SCENE_VERSION) return null;
    const shots = [];
    for (const raw of obj.shots) {
      if (shots.length >= SCENE_MAX_SHOTS) break;
      const shot = cleanShot(raw);
      if (shot) shots.push(shot);
    }
    if (!shots.length) return null;
    return { v: SCENE_VERSION, name: cleanName(obj.name) || 'UNTITLED', shots };
  } catch {
    return null; // a throwing getter or a proxy: nothing usable
  }
}

/**
 * The scene as pretty JSON (always under SCENE_MAX_BYTES), or null when it
 * holds nothing usable.
 * @param {unknown} scene
 * @returns {string|null}
 */
export function serializeScene(scene) {
  const clean = validateScene(scene);
  return clean ? JSON.stringify(clean, null, 2) : null;
}

/**
 * Read a scene file. Null when it is over SCENE_MAX_BYTES, not JSON, or not a
 * usable scene. JSON.parse never touches prototypes, and only known fields
 * are read from what it returns.
 * @param {unknown} text
 */
export function parseSceneJson(text) {
  if (typeof text !== 'string' || text.length > SCENE_MAX_BYTES) return null;
  if (new TextEncoder().encode(text).byteLength > SCENE_MAX_BYTES) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return validateScene(parsed);
}

/**
 * The playback timeline: one step per shot, flown to and then held. Layers,
 * look and target switch on arrival (a cut, at the new view), so a flight
 * never fights a selection's camera nudge or waits on a layer load; the hold
 * runs while they apply. Times are from the start of the run.
 * @param {unknown} scene
 * @returns {{ total: number, totalMs: number, steps: { index: number, total: number,
 *   label: string, shot: object, startMs: number, arriveMs: number, endMs: number }[] }}
 */
export function planPlayback(scene) {
  const clean = validateScene(scene);
  if (!clean) return { total: 0, totalMs: 0, steps: [] };
  const total = clean.shots.length;
  let at = 0;
  const steps = clean.shots.map((shot, index) => {
    const startMs = at;
    const arriveMs = startMs + shot.flyMs;
    at = arriveMs + shot.holdMs;
    return {
      index,
      total,
      label: shotLabel(index, total),
      shot,
      startMs,
      arriveMs,
      endMs: at,
    };
  });
  return { total, totalMs: at, steps };
}

/** "SHOT 02/05" for index 1 of 5. */
export function shotLabel(index, total) {
  return `SHOT ${pad2(index + 1)}/${pad2(total)}`;
}

/** A camera as a short ctOS readout: "48.86N 2.29E 12KM". */
export function describeCamera(c) {
  if (!isObj(c) || !isNum(c.lat) || !isNum(c.lon) || !isNum(c.alt)) return '--';
  const ll = (v, pos, neg) => `${Math.abs(v).toFixed(2)}${v >= 0 ? pos : neg}`;
  const alt =
    c.alt >= 10_000
      ? `${Math.round(c.alt / 1000)}KM`
      : c.alt >= 1000
        ? `${(c.alt / 1000).toFixed(1)}KM`
        : `${Math.round(c.alt)}M`;
  return `${ll(c.lat, 'N', 'S')} ${ll(c.lon, 'E', 'W')} ${alt}`;
}

/** "0:35" / "12:05" for a duration in ms. */
export function formatDuration(ms) {
  const s = Math.round(Math.max(0, Number(ms) || 0) / 1000);
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

/**
 * A shot from a share-link state (core/share/state.js decodeShareHash, or the
 * state handed to encodeShareHash): sensor becomes look, track becomes target.
 * @param {object} state
 * @param {{ holdMs?: number, flyMs?: number, caption?: string }} [extra]
 */
export function shotFromShareState(state, extra = {}) {
  if (!isObj(state)) return null;
  return validateShot({
    camera: state.camera,
    layers: state.layers,
    look: state.sensor,
    target: state.track,
    ...extra,
  });
}

/**
 * The share-link state of a shot, for encodeShareHash (a link to one shot;
 * the share link carries no roll).
 * @param {object} shot
 */
export function shareStateFromShot(shot) {
  const s = validateShot(shot);
  if (!s) return null;
  const { lat, lon, alt, heading, pitch } = s.camera;
  const state = { camera: { lat, lon, alt, heading, pitch }, layers: s.layers };
  if (s.look) state.sensor = s.look;
  if (s.target) state.track = { ...s.target };
  return state;
}

/**
 * Move the item at `from` by `delta` places. Returns a new array (the input
 * is untouched); out of range: an unchanged copy.
 * @template T
 * @param {T[]} list
 * @param {number} from
 * @param {number} delta
 * @returns {T[]}
 */
export function moveItem(list, from, delta) {
  const out = [...list];
  const to = from + delta;
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/**
 * Saved scenes, keyed by name (matched without regard to case), in a
 * localStorage-like `storage` ({ getItem, setItem }). Every call tolerates a
 * missing or throwing storage: reads come back empty, writes report
 * { ok: false, reason: 'storage' }. Stored scenes are validated on every read,
 * so a hand-edited or corrupt entry is dropped, never trusted. Most recently
 * saved first.
 * @param {{ getItem: Function, setItem: Function } | null | undefined} storage
 * @param {{ key?: string, max?: number }} [opts]
 */
export function createSceneStore(
  storage,
  { key = SCENE_STORAGE_KEY, max = SCENE_STORE_MAX } = {},
) {
  const same = (a, b) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();

  function read() {
    let raw = null;
    try {
      raw = storage?.getItem(key) ?? null;
    } catch {
      return [];
    }
    if (typeof raw !== 'string' || raw.length > SCENE_MAX_BYTES * max) return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!isObj(parsed) || parsed.v !== SCENE_VERSION || !Array.isArray(parsed.scenes))
      return [];
    const out = [];
    for (const s of parsed.scenes) {
      if (out.length >= max) break;
      const clean = validateScene(s);
      if (clean && !out.some((o) => same(o.name, clean.name))) out.push(clean);
    }
    return out;
  }

  function write(scenes) {
    try {
      if (!storage) return false;
      storage.setItem(key, JSON.stringify({ v: SCENE_VERSION, scenes }));
      return true;
    } catch {
      return false; // quota, private mode, blocked site data
    }
  }

  return {
    /** @returns {{ name: string, shots: number }[]} */
    list: () => read().map((s) => ({ name: s.name, shots: s.shots.length })),

    /** @returns {object|null} a fresh copy of the saved scene */
    get(name) {
      return read().find((s) => same(s.name, name)) ?? null;
    },

    /**
     * Save (or replace) a scene under its name.
     * @returns {{ ok: true, scene: object, replaced: boolean } |
     *   { ok: false, reason: 'invalid' | 'full' | 'storage' }}
     */
    save(scene) {
      const clean = validateScene(scene);
      if (!clean) return { ok: false, reason: 'invalid' };
      const all = read();
      const rest = all.filter((s) => !same(s.name, clean.name));
      const replaced = rest.length < all.length;
      if (!replaced && all.length >= max) return { ok: false, reason: 'full' };
      if (!write([clean, ...rest])) return { ok: false, reason: 'storage' };
      return { ok: true, scene: clean, replaced };
    },

    /** @returns {boolean} true when a scene was removed */
    remove(name) {
      const all = read();
      const rest = all.filter((s) => !same(s.name, name));
      return rest.length < all.length && write(rest);
    },

    /**
     * Rename a saved scene. A name in use by another scene is refused (a
     * change of case alone is allowed).
     * @returns {{ ok: true, name: string } |
     *   { ok: false, reason: 'invalid' | 'missing' | 'exists' | 'storage' }}
     */
    rename(from, to) {
      const name = cleanName(to);
      if (!name) return { ok: false, reason: 'invalid' };
      const all = read();
      const i = all.findIndex((s) => same(s.name, from));
      if (i < 0) return { ok: false, reason: 'missing' };
      if (all.some((s, j) => j !== i && same(s.name, name)))
        return { ok: false, reason: 'exists' };
      const next = all.map((s, j) => (j === i ? { ...s, name } : s));
      return write(next) ? { ok: true, name } : { ok: false, reason: 'storage' };
    },
  };
}
