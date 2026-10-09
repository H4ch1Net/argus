// Session memory: the app reopens as it was left. One small JSON record in
// localStorage on this device (nothing is sent anywhere): the view as a share
// hash (camera, layers, sensor, imagery, labels, target; ./state.js), the
// display controls in VIEW that have no setting of their own (remembered by
// their label), the webcam and traffic-camera filter chips, and the preset
// that was on (with the view it gives back). Pure apart from the injected
// storage and timers, so every shell can test it; main.js collects and
// applies. The car (Android Auto) shares the origin and storage with the
// phone app but keeps its own state, so it never reads or writes this record.
//
// Decoding fails closed field by field: a malformed part is dropped, the rest
// still restores (the hash itself is checked again by decodeShareHash).

import { SHARE_MAX_LENGTH } from './state.js';

export const SESSION_KEY = 'argus.session.v1';
/** Written by earlier versions ("Start in: last view"); read once as a fallback. */
export const LEGACY_VIEW_KEY = 'argus.lastView';
export const SESSION_MAX_LENGTH = 16 * 1024;

/** VIEW switches remembered by label (the rest have a setting, or are momentary). */
export const SESSION_SWITCHES = Object.freeze([
  'Mono imagery',
  'Viewport frame',
  'Aircraft models',
  'Starlink dense',
  'CRT overlay',
  'Sharpen',
  'Bloom',
  'Intel HUD',
]);
/** VIEW choices remembered by label: the label of the option that was pressed. */
export const SESSION_CHOICES = Object.freeze([
  'Tracking boxes',
  'Thermal palette',
  'NVG gain',
]);
/** Chip filters remembered by id: the selected ids. */
export const SESSION_FILTERS = Object.freeze(['webcams', 'trafficcams']);

const KEY = /^[a-z][a-z0-9_-]{0,31}$/;
const OPTION = /^[A-Za-z0-9][A-Za-z0-9 .%+_-]{0,23}$/;
const MAX_LIST = 64;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const finite = (v, lo, hi) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function keyList(raw, allow) {
  if (!Array.isArray(raw) || raw.length > MAX_LIST) return null;
  const out = [];
  for (const k of raw) {
    if (typeof k !== 'string' || !KEY.test(k)) continue;
    if (allow && !allow.has(k)) continue;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** A camera view as cameraControls.getView() gives it, or null. */
export function cleanView(v) {
  if (!isObj(v)) return null;
  const { longitude, latitude, height } = v;
  if (!finite(longitude, -180, 180) || !finite(latitude, -90, 90)) return null;
  if (!finite(height, 1, 100_000_000)) return null;
  const out = { longitude, latitude, height };
  for (const [k, lo, hi] of [
    ['heading', -720, 720],
    ['pitch', -90, 90],
    ['roll', -180, 180],
  ])
    if (finite(v[k], lo, hi)) out[k] = v[k];
  return out;
}

function cleanControls(raw) {
  const out = { switches: {}, choices: {} };
  if (!isObj(raw)) return out;
  if (isObj(raw.switches))
    for (const k of SESSION_SWITCHES)
      if (typeof raw.switches[k] === 'boolean') out.switches[k] = raw.switches[k];
  if (isObj(raw.choices))
    for (const k of SESSION_CHOICES) {
      const v = raw.choices[k];
      if (typeof v === 'string' && OPTION.test(v)) out.choices[k] = v;
    }
  return out;
}

function cleanFilters(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const k of SESSION_FILTERS) {
    const list = keyList(raw[k]);
    if (list) out[k] = list;
  }
  return out;
}

function cleanPreset(raw, { presetIds, layerKeys } = {}) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !KEY.test(raw.id)) return null;
  if (presetIds && !new Set(presetIds).has(raw.id)) return null;
  const out = { id: raw.id };
  const keys = layerKeys ? new Set(layerKeys) : null;
  const b = raw.before;
  if (isObj(b)) {
    const layers = keyList(b.layers, keys);
    const view = cleanView(b.view);
    if (layers && view) out.before = { layers, view };
  }
  // The layers the preset itself put on: what is on beyond them was switched
  // on by hand, and leaving the preset keeps it.
  const staged = out.before ? keyList(raw.staged, keys) : null;
  if (staged) out.staged = staged;
  return out;
}

/**
 * The record to store. Fields that do not fit are left out.
 * @param {{ hash?: string, controls?: object, filters?: object,
 *   preset?: { id: string, before?: { layers: string[], view: object },
 *     staged?: string[] } | null,
 *   at?: number }} s
 * @returns {string}
 */
export function encodeSession(s = {}) {
  const out = { v: 1, at: Number.isFinite(s.at) ? Math.round(s.at) : Date.now() };
  if (
    typeof s.hash === 'string' &&
    s.hash.startsWith('#v=1') &&
    s.hash.length <= SHARE_MAX_LENGTH
  )
    out.hash = s.hash;
  const controls = cleanControls(s.controls);
  if (Object.keys(controls.switches).length || Object.keys(controls.choices).length)
    out.controls = controls;
  const filters = cleanFilters(s.filters);
  if (Object.keys(filters).length) out.filters = filters;
  const preset = cleanPreset(s.preset);
  if (preset) out.preset = preset;
  return JSON.stringify(out);
}

/**
 * Read a stored record back. Null when it is not a v1 session at all; a bad
 * field is dropped on its own.
 * @param {string|null} text
 * @param {{ presetIds?: Iterable<string>, layerKeys?: Iterable<string> }} [allow]
 */
export function decodeSession(text, allow = {}) {
  if (typeof text !== 'string' || !text || text.length > SESSION_MAX_LENGTH) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw) || raw.v !== 1) return null;
  const out = {
    at: Number.isFinite(raw.at) ? raw.at : 0,
    hash:
      typeof raw.hash === 'string' &&
      raw.hash.startsWith('#v=1') &&
      raw.hash.length <= SHARE_MAX_LENGTH
        ? raw.hash
        : null,
    controls: cleanControls(raw.controls),
    filters: cleanFilters(raw.filters),
    preset: cleanPreset(raw.preset, allow),
  };
  return out;
}

/**
 * How this launch starts.
 *   link     the address bar holds a share link: it wins
 *   session  "Start in: where I left" with a saved session (or an older last view)
 *   aroundme Around Me (the phone's first launch and default, or the setting)
 *   default  the default layers at the world view
 * The car never resumes the phone's session.
 * @param {{ shell: string, hash?: string, startView?: string,
 *   session?: object|null, legacyView?: string|null }} o
 * @returns {{ kind: 'link'|'session'|'aroundme'|'default', hash: string|null,
 *   session: object|null }}
 */
export function startPlan({
  shell,
  hash = '',
  startView = 'last',
  session = null,
  legacyView = null,
}) {
  if (typeof hash === 'string' && hash.length > 1)
    return { kind: 'link', hash, session: null };
  if (shell === 'car') return { kind: 'default', hash: null, session: null };
  if (startView === 'last') {
    if (session?.hash) return { kind: 'session', hash: session.hash, session };
    if (typeof legacyView === 'string' && legacyView.startsWith('#v=1'))
      return { kind: 'session', hash: legacyView, session: null };
  }
  if (startView === 'aroundme' || shell === 'mobile')
    return { kind: 'aroundme', hash: null, session: null };
  return { kind: 'default', hash: null, session: null };
}

/** Read the stored session (and the older last view) without throwing. */
export function readSession(storage, allow) {
  let text = null;
  let legacy = null;
  try {
    text = storage?.getItem(SESSION_KEY) ?? null;
    legacy = storage?.getItem(LEGACY_VIEW_KEY) ?? null;
  } catch {
    return { session: null, legacyView: null };
  }
  return { session: decodeSession(text, allow), legacyView: legacy };
}

/**
 * Save on change, debounced (delayMs after the last change, but never later
 * than maxWaitMs after the first), and at once on flush(): a phone WebView may
 * be killed in the background without any unload event, so the shell flushes
 * when the page is hidden. collect() returns the state for encodeSession.
 * @param {{ storage: object|null, collect: () => object, delayMs?: number,
 *   maxWaitMs?: number, now?: () => number, setTimer?: Function, clearTimer?: Function }} o
 */
export function createSessionSaver({
  storage,
  collect,
  delayMs = 800,
  maxWaitMs = 5000,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
}) {
  let timer = null;
  let firstAt = 0;
  let writes = 0;
  function write() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    firstAt = 0;
    let text;
    try {
      text = encodeSession({ ...collect(), at: now() });
    } catch {
      return false; // the scene is mid-teardown: keep the last good record
    }
    try {
      storage?.setItem(SESSION_KEY, text);
      writes += 1;
      return true;
    } catch {
      return false; // storage full or blocked: the session still runs
    }
  }
  return {
    /** Something changed: save soon. */
    schedule() {
      const t = now();
      if (timer === null) firstAt = t;
      else clearTimer(timer);
      const wait = Math.max(0, Math.min(delayMs, firstAt + maxWaitMs - t));
      timer = setTimer(write, wait);
    },
    /** Save now (the page is being hidden or closed). */
    flush: write,
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      firstAt = 0;
    },
    get pending() {
      return timer !== null;
    },
    get writes() {
      return writes;
    },
  };
}
