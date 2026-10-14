// Recent destinations: the places routes were planned to (WHERE TO on the
// phone and the desktop, the car's WHERE TO), newest first, kept in this
// browser only (localStorage, shared by the phone and car pages of the
// Android app). A place planned to again moves to the top (the same place:
// the same id, or within 50 m). Pure: storage is injected and every record
// is validated.

export const RECENTS_KEY = 'argus.recents.v1';
export const RECENTS_MAX = 12;
const SAME_M = 50;

const num = (v, lo, hi) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
const isControl = (ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127;
const text = (v, max) =>
  Array.from(String(v ?? ''), (ch) => (isControl(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** One recent place, validated, or null. */
export function validateRecent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = num(raw.lat, -90, 90);
  const lon = num(raw.lon, -180, 180);
  const name = text(raw.name, 120);
  if (lat === null || lon === null || !name) return null;
  return {
    id: text(raw.id, 120) || `${lat.toFixed(5)},${lon.toFixed(5)}`,
    name,
    detail: text(raw.detail, 160),
    kind: text(raw.kind, 40) || 'place',
    lat,
    lon,
    at: num(raw.at, 0, 1e13) ?? Date.now(),
  };
}

function metres(aLat, aLon, bLat, bLon) {
  const k = Math.cos(((aLat + bLat) * Math.PI) / 360);
  return Math.hypot((bLat - aLat) * 111_320, (bLon - aLon) * 111_320 * k);
}

/**
 * @param {{ getItem: Function, setItem: Function }|null} storage
 */
export function createRecents(storage, { max = RECENTS_MAX } = {}) {
  const read = () => {
    try {
      const arr = JSON.parse(storage?.getItem(RECENTS_KEY) || '[]');
      return Array.isArray(arr)
        ? arr.map(validateRecent).filter(Boolean).slice(0, max)
        : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      storage?.setItem(RECENTS_KEY, JSON.stringify(list));
    } catch {
      // storage blocked or full: recents are a convenience
    }
  };
  const same = (a, b) => a.id === b.id || metres(a.lat, a.lon, b.lat, b.lon) <= SAME_M;
  return {
    /** Newest first (read from storage each time: the car page adds too). */
    list: () => read(),
    /** Put a place at the top (an older entry for the same place goes). */
    add(raw) {
      const p = validateRecent({ ...raw, at: Date.now() });
      if (!p) return null;
      write([p, ...read().filter((x) => !same(x, p))].slice(0, max));
      return p;
    },
    remove(id) {
      write(read().filter((x) => x.id !== id));
    },
    clear: () => write([]),
  };
}
