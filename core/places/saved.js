// Saved places: the user's own landmarks and locations, kept in this browser
// only (localStorage), exported and imported as JSON. Pure: storage is
// injected and every record is validated, so a hand-edited or stale entry is
// dropped rather than breaking the map. Places are points the user chose: a
// view (with the camera that framed it), a point tapped on the globe, a
// search result, or a long press on the map (WHAT'S HERE > SAVE). One list
// serves WHERE TO (HOME, WORK, SAVED), the car's WHERE TO, TOOLS > MY PLACES,
// the search launcher and the My places layer. HOME and WORK are kinds held
// by one place each: setting a new one makes the old one a plain place. The
// phone page and the car page share the storage, so a change made in one is
// read again by the other (the storage event, and refresh()).

export const PLACES_KEY = 'argus.places.v1';
export const PLACES_MAX = 500;
const NAME_MAX = 60;
const NOTE_MAX = 200;
const KINDS = ['place', 'home', 'work', 'landmark', 'watch', 'camera'];

const num = (v, lo, hi) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
// Control characters become spaces (so a pasted name cannot carry them).
const isControl = (ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127;
const text = (v, max) =>
  Array.from(String(v ?? ''), (ch) => (isControl(ch) ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/** One place, validated, or null. */
export function validatePlace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = num(raw.lat, -90, 90);
  const lon = num(raw.lon, -180, 180);
  const name = text(raw.name, NAME_MAX);
  if (lat === null || lon === null || !name) return null;
  const out = {
    // (test() would stringify undefined to 'undefined', a valid-looking id)
    id: typeof raw.id === 'string' && /^[a-z0-9-]{4,40}$/.test(raw.id) ? raw.id : newId(),
    name,
    lat,
    lon,
    kind: KINDS.includes(raw.kind) ? raw.kind : 'place',
    note: text(raw.note, NOTE_MAX),
    at: num(raw.at, 0, 1e13) ?? Date.now(),
  };
  const c = raw.view;
  if (c && typeof c === 'object') {
    const view = {
      lat: num(c.lat, -90, 90),
      lon: num(c.lon, -180, 180),
      alt: num(c.alt, 1, 1e8),
      heading: num(c.heading, -360, 720) ?? 0,
      pitch: num(c.pitch, -90, 90) ?? -90,
    };
    if (view.lat !== null && view.lon !== null && view.alt !== null) out.view = view;
  }
  return out;
}

let counter = 0;
function newId() {
  counter = (counter + 1) % 1e6;
  return `p-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Metres between two points (equirectangular: fine at a few km). */
function metres(aLat, aLon, bLat, bLon) {
  const k = Math.cos(((aLat + bLat) * Math.PI) / 360);
  return Math.hypot((bLat - aLat) * 111_320, (bLon - aLon) * 111_320 * k);
}

/** One place per role: HOME and WORK. */
export const ROLES = ['home', 'work'];

/**
 * @param {{ getItem: Function, setItem: Function }|null} storage
 * @param {{ events?: { addEventListener?: Function }|null }} [opts]
 *   events: where 'storage' events arrive (the window), so a change made by
 *   another page of this origin (the car's) is read again.
 */
export function createPlacesStore(storage, { events = null } = {}) {
  let places = [];
  let raw = null; // what storage held when last read or written
  function read() {
    let text = null;
    try {
      text = storage?.getItem(PLACES_KEY) ?? null;
    } catch {
      text = null;
    }
    if (text === raw) return false;
    raw = text;
    try {
      const arr = JSON.parse(text || '[]');
      places = Array.isArray(arr)
        ? arr.map(validatePlace).filter(Boolean).slice(0, PLACES_MAX)
        : [];
    } catch {
      places = [];
    }
    return true;
  }
  read();
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(places));
  const commit = () => {
    try {
      raw = JSON.stringify(places);
      storage?.setItem(PLACES_KEY, raw);
    } catch {
      // storage blocked or full: places still work this session
    }
    emit();
  };
  /** A role moves: whoever held it becomes a plain place. */
  const freeRole = (kind, keepId) => {
    if (!ROLES.includes(kind)) return;
    places = places.map((p) =>
      p.kind === kind && p.id !== keepId ? { ...p, kind: 'place' } : p,
    );
  };
  events?.addEventListener?.('storage', (e) => {
    if ((e?.key === PLACES_KEY || e?.key === null) && read()) emit();
  });
  return {
    list: () => places.slice(),
    get: (id) => places.find((p) => p.id === id) ?? null,
    /** Read storage again (another page may have changed it); true when it had. */
    refresh() {
      const changed = read();
      if (changed) emit();
      return changed;
    },
    /** The place holding a role ('home' | 'work'), or null. */
    role: (kind) => places.find((p) => p.kind === kind) ?? null,
    /** The saved place within `maxM` metres of a point (the nearest), or null. */
    near(lat, lon, maxM = 30) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      let best = null;
      let bestM = maxM;
      for (const p of places) {
        const m = metres(lat, lon, p.lat, p.lon);
        if (m <= bestM) [best, bestM] = [p, m];
      }
      return best;
    },
    /** Add a place; returns it (validated) or null when invalid or full. */
    add(raw) {
      if (places.length >= PLACES_MAX) return null;
      const p = validatePlace({ ...raw, id: undefined, at: Date.now() });
      if (!p) return null;
      freeRole(p.kind, p.id);
      places = [p, ...places];
      commit();
      return p;
    },
    update(id, patch) {
      const i = places.findIndex((p) => p.id === id);
      if (i < 0) return null;
      const p = validatePlace({ ...places[i], ...patch, id });
      if (!p) return null;
      places = places.map((x, j) => (j === i ? p : x));
      freeRole(p.kind, p.id);
      commit();
      return p;
    },
    /**
     * Give a place a role ('home' | 'work') or take it away (null: a plain
     * place again). The role's previous holder becomes a plain place.
     */
    setRole(id, kind) {
      const p = places.find((x) => x.id === id);
      if (!p) return null;
      return this.update(id, { kind: ROLES.includes(kind) ? kind : 'place' });
    },
    remove(id) {
      const before = places.length;
      places = places.filter((p) => p.id !== id);
      if (places.length !== before) commit();
    },
    /**
     * Name (and note) search, case- and accent-insensitive; "home" and "work"
     * find the place holding that role.
     */
    search(query, limit = 5) {
      const fold = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const q = fold(query).trim();
      if (q.length < 2) return [];
      return places
        .filter(
          (p) =>
            fold(`${p.name} ${p.note}`).includes(q) ||
            (ROLES.includes(p.kind) && p.kind.startsWith(q)),
        )
        .sort((a, b) => Number(ROLES.includes(b.kind)) - Number(ROLES.includes(a.kind)))
        .slice(0, limit);
    },
    export: () => JSON.stringify({ v: 1, places }, null, 2),
    /** Import an exported file's text (merged, duplicates by name+position skipped). */
    import(textIn) {
      let obj;
      try {
        obj = JSON.parse(String(textIn).slice(0, 512 * 1024));
      } catch {
        return 0;
      }
      if (obj?.v !== 1 || !Array.isArray(obj.places)) return 0;
      const key = (p) => `${p.name}|${p.lat.toFixed(5)}|${p.lon.toFixed(5)}`;
      const have = new Set(places.map(key));
      let added = 0;
      for (const raw of obj.places) {
        const p = validatePlace(raw);
        if (!p || have.has(key(p)) || places.length >= PLACES_MAX) continue;
        // A HOME or WORK in the file does not take the role from this device's.
        const taken = ROLES.includes(p.kind) && places.some((x) => x.kind === p.kind);
        places.push({ ...p, id: newId(), kind: taken ? 'place' : p.kind });
        have.add(key(p));
        added += 1;
      }
      if (added) commit();
      return added;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** A saved place in the Layer SDK's normalized shape (for the map layer). */
export function placeToNormalized(p) {
  return {
    id: p.id,
    type: 'place',
    position: { latitude: p.lat, longitude: p.lon, altitude: 0 },
    meta: { name: p.name, kind: p.kind, note: p.note, view: p.view ?? null, at: p.at },
  };
}

/** The card for a saved place. */
export function describePlace(n) {
  const m = n.meta;
  return {
    id: n.id,
    title: m.name,
    subtitle: `SAVED ${m.kind.toUpperCase()}`,
    rows: [
      [
        'Coordinates',
        `${n.position.latitude.toFixed(5)}, ${n.position.longitude.toFixed(5)}`,
      ],
      ...(m.note ? [['Note', m.note]] : []),
      ['Saved', new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') + 'Z'],
      ['Kept', 'On this device only'],
    ],
  };
}
