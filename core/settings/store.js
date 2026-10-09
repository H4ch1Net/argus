// User settings: one small validated object kept in localStorage on this
// device. Pure (storage is injected), so it is testable and every value is
// checked on the way in: a stale or hand-edited entry falls back to its
// default instead of breaking the app. Applied at boot (quality, frame rate,
// resolution, globe detail) and live (units, clock, coordinates, interface
// scale, Earth options).

import { resolutionScaleFor } from '../capability/profile.js';
import { ICON_SETTINGS_SCHEMA } from '../ui/iconPrefs.js';

export const SETTINGS_KEY = 'argus.settings.v1';

/** Each setting: its default and the values it may take. */
export const SETTINGS_SCHEMA = Object.freeze({
  // Performance (read at boot; a tier change reloads the page).
  tier: { def: 'auto', values: ['auto', 'minimal', 'balanced', 'full'] },
  fps: { def: 'auto', values: ['auto', 20, 30, 60] },
  // Rendered pixels per CSS pixel ('native': the panel's own density).
  resolution: { def: 'auto', values: ['auto', 1, 1.5, 2, 2.5, 'native'] },
  detail: { def: 'standard', values: ['low', 'standard', 'high'] },
  dataSaver: { def: false, values: [true, false] },
  // Interface.
  units: { def: 'metric', values: ['metric', 'imperial', 'nautical'] },
  clock: { def: 'utc', values: ['utc', 'local'] },
  coords: { def: 'dec', values: ['dec', 'dms', 'mgrs'] },
  uiScale: { def: 100, values: [90, 100, 115, 130] },
  reducedMotion: { def: false, values: [true, false] },
  startView: { def: 'default', values: ['default', 'last', 'aroundme'] },
  // The user's own map marker (core/ui/selfIcons.js SELF_ICONS, same order).
  selfIcon: {
    def: 'chevron',
    values: ['chevron', 'triangle', 'diamond', 'car', 'crosshair', 'dot', 'beam'],
  },
  // Earth.
  imagery: {
    def: 'auto',
    values: [
      'auto',
      'dark',
      'satellite',
      'sentinel',
      'bluemarble',
      'blackmarble',
      'topo',
      'streets',
      'base',
    ],
  },
  terrain: { def: 'auto', values: ['auto', 'flat', 'terrain', 'photoreal'] },
  lighting: { def: false, values: [true, false] },
  atmosphere: { def: true, values: [true, false] },
  stars: { def: true, values: [true, false] },
  exaggeration: { def: 1, values: [1, 1.5, 2, 3] },
  // Map objects (VIEW): surveillance draws the nearest 60 or all in view;
  // camera previews show stills beside the nearest cameras (off in the car).
  survScope: { def: 'nearest', values: ['nearest', 'all'] },
  camPreviews: { def: true, values: [true, false] },
  camPreviewCount: { def: 4, values: [2, 4, 6, 8] },
  // Navigation (core/ui/navPanel.js): the last travel mode and route options.
  navMode: { def: 'drive', values: ['drive', 'walk', 'bike'] },
  navAvoidHighways: { def: false, values: [true, false] },
  navTraffic: { def: true, values: [true, false] },
  // Shodan snapshot and host sample (VIEW > SHODAN; ids as in
  // core/layers/shodan/snapshots.js), and the TomTom flow readout (VIEW > ROAD FLOW).
  shodanSnapshot: {
    def: 'web',
    values: [
      'web',
      'rdp',
      'vnc',
      'telnet',
      'smb',
      'databases',
      'mqtt',
      'modbus',
      's7',
      'bacnet',
    ],
  },
  shodanSample: { def: false, values: [true, false] },
  flowReadout: { def: false, values: [true, false] },
  // Map: merge nearby contacts into one marker until zoomed in (VIEW > MERGE
  // NEARBY; the Layer SDK's clustering).
  merge: { def: true, values: [true, false] },
  // Map icons (SETTINGS > ICONS, core/ui/iconPrefs.js): iconScaling ('zoom' or
  // 'fixed'), iconSize (global %), and per icon layer iconSize.<layer> (%)
  // and, where the layer has variants, iconVariant.<layer>.
  ...ICON_SETTINGS_SCHEMA,
});

/** The defaults, as a fresh object. */
export function defaultSettings() {
  return Object.fromEntries(Object.entries(SETTINGS_SCHEMA).map(([k, v]) => [k, v.def]));
}

/** Keep only known keys with allowed values; everything else takes its default. */
export function validateSettings(raw) {
  const out = defaultSettings();
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, spec] of Object.entries(SETTINGS_SCHEMA)) {
    if (spec.values.includes(raw[k])) out[k] = raw[k];
  }
  return out;
}

/**
 * @param {{ getItem: Function, setItem: Function, removeItem?: Function }|null} storage
 */
export function createSettingsStore(storage) {
  let state = defaultSettings();
  try {
    const text = storage?.getItem(SETTINGS_KEY);
    if (text) state = validateSettings(JSON.parse(text));
  } catch {
    state = defaultSettings();
  }
  const listeners = new Set();
  const persist = () => {
    try {
      storage?.setItem(SETTINGS_KEY, JSON.stringify(state));
    } catch {
      // private mode or full storage: the setting still applies this session
    }
  };
  return {
    get: (key) => state[key],
    all: () => ({ ...state }),
    /** Set one value; returns the value applied (the default when invalid). */
    set(key, value) {
      const spec = SETTINGS_SCHEMA[key];
      if (!spec) return undefined;
      const next = spec.values.includes(value) ? value : spec.def;
      if (state[key] === next) return next;
      state = { ...state, [key]: next };
      persist();
      listeners.forEach((fn) => fn(key, next, state));
      return next;
    },
    reset() {
      state = defaultSettings();
      try {
        storage?.removeItem?.(SETTINGS_KEY);
      } catch {
        // ignore
      }
      for (const k of Object.keys(state))
        listeners.forEach((fn) => fn(k, state[k], state));
    },
    export: () => JSON.stringify({ v: 1, settings: state }, null, 2),
    /** Import an exported file's text; returns true when it was a settings file. */
    import(text) {
      let obj;
      try {
        obj = JSON.parse(String(text).slice(0, 64 * 1024));
      } catch {
        return false;
      }
      if (obj?.v !== 1 || typeof obj.settings !== 'object') return false;
      state = validateSettings(obj.settings);
      persist();
      for (const k of Object.keys(state))
        listeners.forEach((fn) => fn(k, state[k], state));
      return true;
    },
    /** fn(key, value, all) after any change. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * Profile overrides from the settings: what bootGlobe applies on top of the
 * tier's quality profile. 'auto' leaves the tier's own value.
 */
export function profileOverrides(s, dpr = 1) {
  const out = {};
  if (s.fps !== 'auto') out.targetFrameRate = s.fps;
  if (s.resolution !== 'auto')
    out.resolutionScale = resolutionScaleFor(s.resolution, dpr);
  out.maximumScreenSpaceError = { low: 4, standard: undefined, high: 1.33 }[s.detail];
  if (out.maximumScreenSpaceError === undefined) delete out.maximumScreenSpaceError;
  return out;
}

const M_PER_FT = 0.3048;
const M_PER_MI = 1609.344;
const M_PER_NM = 1852;

/** A distance in the chosen units: "850 M" / "3.2 KM", "2,790 FT" / "2.0 MI", "1.7 NM". */
export function formatDistance(m, units = 'metric') {
  if (!Number.isFinite(m)) return '--';
  if (units === 'imperial') {
    return m < M_PER_MI * 0.2
      ? `${Math.round(m / M_PER_FT).toLocaleString('en-US')} FT`
      : `${(m / M_PER_MI).toFixed(m < M_PER_MI * 10 ? 1 : 0)} MI`;
  }
  if (units === 'nautical') {
    return m < M_PER_NM * 0.1
      ? `${Math.round(m)} M`
      : `${(m / M_PER_NM).toFixed(m < M_PER_NM * 10 ? 1 : 0)} NM`;
  }
  return m < 1000 ? `${Math.round(m)} M` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} KM`;
}

/** An altitude or height: metres, or feet for imperial and nautical (aviation). */
export function formatAltitude(m, units = 'metric') {
  if (!Number.isFinite(m)) return '--';
  if (units === 'metric') {
    return m < 10_000
      ? `${Math.round(m).toLocaleString('en-US')} M`
      : `${Math.round(m / 1000).toLocaleString('en-US')} KM`;
  }
  const ft = m / M_PER_FT;
  return ft < 100_000
    ? `${Math.round(ft).toLocaleString('en-US')} FT`
    : `${Math.round(m / M_PER_MI).toLocaleString('en-US')} MI`;
}

/** A speed given in m/s: KM/H, MPH or KT. */
export function formatSpeed(mps, units = 'metric') {
  if (!Number.isFinite(mps)) return '--';
  if (units === 'imperial') return `${Math.round(mps * 2.236936)} MPH`;
  if (units === 'nautical') return `${Math.round(mps * 1.943844)} KT`;
  return `${Math.round(mps * 3.6)} KM/H`;
}
