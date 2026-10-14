import { formatDistance } from '../settings/store.js';
import { FRESH_MS, distanceM } from './selfPosition.js';

// GEO: the view stack's "centre on me" cell, the same on phone and desktop,
// working as a map app's location button.
//
//   tap 1  centre on me and follow: a fix younger than 30 s, a short flight
//          there at once; otherwise the last known position (this device
//          remembers it) at once while the cell shows LOCATING, then a short
//          hop onto the first fresh fix. Once there the camera follows the
//          marker (core/geo/follow.js). A coarse first fix is refined: for
//          20 s, a better fix that lands off-centre re-centres.
//   tap 2  heading-up: the map turns with the way you travel.
//   tap 3  free: the camera stays where it is.
// A drag on the map pauses following (state 'paused': the cell offers
// RECENTER, and a tap recentres); driving with the map untouched resumes it.
// Failures are a state on the cell plus one log entry, never a popup. The
// sensors stay open while GEO is in use and three minutes after (the app
// usually keeps them open anyway once location is allowed: selfPosition).

const HOLD_MS = 3 * 60_000;
const REFINE_MS = 20_000;
const ERROR_SHOW_MS = 3000;

/** Camera height for a fix: closer the better it is (street to city). */
export function altitudeFor(fix, { min = 1800, max = 30_000 } = {}) {
  const a = Number.isFinite(fix?.accuracy) ? fix.accuracy : 1000;
  return Math.round(Math.min(max, Math.max(min, a * 12)));
}

const sameView = (a, b) =>
  Boolean(a && b) &&
  Math.abs(a.latitude - b.latitude) < 1e-6 &&
  Math.abs(a.longitude - b.longitude) < 1e-6 &&
  Math.abs(a.height - b.height) < Math.max(1, a.height * 1e-4) &&
  Math.abs(((a.heading - b.heading + 540) % 360) - 180) < 0.2;

/** The cell's state for a follow state: following | heading | paused, or null when off. */
export function followCellState(f) {
  if (!f || f.mode === 'off' || !f.mode) return null;
  if (f.paused) return 'paused';
  return f.mode === 'heading' ? 'heading' : 'following';
}

/**
 * @param {{ selfPosition: object, camera: { flyAround: Function, getView: Function },
 *   timeoutMs?: number, holdMs?: number, minAltitude?: number,
 *   beforeFollow?: () => void, intercept?: () => boolean,
 *   log?: (entry: object) => void, now?: () => number,
 *   units?: () => string }} deps  units: the settings' unit system, for the notes;
 *   intercept: called first on a tap, true when it handled it (navigation recentres)
 */
export function createGeoControl({
  selfPosition,
  camera,
  timeoutMs = 12_000,
  holdMs = HOLD_MS,
  minAltitude = 1800,
  beforeFollow,
  intercept,
  log,
  now = () => Date.now(),
  units = () => 'metric',
}) {
  const listeners = new Set();
  // idle | locating | following | heading | paused | centered | error
  let state = 'idle';
  let note = '';
  let landed = null; // the view our last flight ended on
  let flight = 0; // id of the newest flight we started
  let cancelled = false; // the user stopped one of our flights (a press on the globe)
  let holdTimer = null;
  let errorTimer = null;
  let refineUntil = 0;
  let unsubFix = null;

  function set(next, text = '') {
    if (next === state && text === note) return;
    state = next;
    note = text;
    clearTimeout(errorTimer);
    if (next === 'error') errorTimer = setTimeout(() => set('idle'), ERROR_SHOW_MS);
    for (const fn of listeners) fn({ state, note });
  }

  function hold() {
    selfPosition.start('geo');
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => selfPosition.stop('geo'), holdMs);
  }

  const followNow = () => selfPosition.followState?.() ?? { mode: 'off' };

  // The cell mirrors follow-me, whoever changes it (a drag pauses it, FOLLOW
  // on a contact ends it, driving resumes it).
  selfPosition.watch?.((s) => {
    if (state === 'locating' || state === 'error') return;
    const cell = followCellState({ mode: s.follow ?? 'off', paused: s.paused });
    if (cell) {
      if (cell !== state) set(cell, cell === 'heading' ? 'HEADING UP' : '');
    } else if (state === 'following' || state === 'heading' || state === 'paused') {
      set('idle', 'FREE');
    }
  });

  const accuracyNote = (fix) =>
    Number.isFinite(fix?.accuracy) ? `±${formatDistance(fix.accuracy, units())}` : '';

  /** Fly to a fix; resolves true when the flight landed (not superseded or cancelled). */
  async function fly(fix, duration, { coarse = false } = {}) {
    const id = (flight += 1);
    const view = camera.getView();
    const ok = await camera.flyAround({
      longitude: fix.lon,
      latitude: fix.lat,
      groundM: Number.isFinite(fix.alt) ? fix.alt : 0,
      range: altitudeFor(fix, {
        min: coarse ? Math.max(4000, minAltitude) : minAltitude,
        max: coarse ? 60_000 : 30_000,
      }),
      heading: Number.isFinite(view?.heading) ? view.heading : 0,
      pitch: -90,
      duration,
    });
    if (id !== flight) return false; // a newer flight replaced this one
    if (ok) landed = camera.getView();
    else cancelled = true;
    return ok;
  }

  const userMoved = () => !sameView(camera.getView(), landed);

  // A better fix after a coarse one: hop onto it while it is still being refined.
  function watchRefine() {
    unsubFix?.();
    refineUntil = now() + REFINE_MS;
    unsubFix = selfPosition.subscribe((fix) => {
      const following = state === 'following' || state === 'heading';
      if (now() > refineUntil || !(following || state === 'centered')) {
        unsubFix?.();
        unsubFix = null;
        return;
      }
      if (!landed || (!following && userMoved())) return;
      const off = distanceM(
        { lat: landed.latitude, lon: landed.longitude },
        { lat: fix.lat, lon: fix.lon },
      );
      if (off > Math.max(30, altitudeFor(fix, { min: minAltitude }) * 0.12)) {
        landed = { ...landed, latitude: fix.lat, longitude: fix.lon };
        fly(fix, 0.7);
        if (!following) set('centered', accuracyNote(fix));
      }
    });
  }

  // Centred on the user: hand the camera to follow-me.
  function follow(text) {
    beforeFollow?.();
    // The cell first, so the watch below finds it already following.
    set('following', text);
    const mode = selfPosition.follow?.('follow');
    if (mode !== 'follow' && mode !== true) set('centered', text);
  }

  async function press() {
    if (state === 'locating') return;
    try {
      if (intercept?.()) return;
    } catch {
      // the hook is best effort
    }
    const f = followNow();
    if (f.mode && f.mode !== 'off') {
      hold();
      if (f.paused) selfPosition.recenter?.();
      else selfPosition.follow(f.mode === 'follow' ? 'heading' : false);
      return;
    }
    hold();
    landed = null;
    cancelled = false;
    const fix = selfPosition.get();
    if (fix && now() - fix.t < FRESH_MS) {
      set('centered', accuracyNote(fix));
      const ok = await fly(fix, 0.8);
      if (ok && state === 'centered') follow(note);
      else if (!ok && state === 'centered') set('idle', note);
      watchRefine();
      return;
    }
    // Somewhere to look while the sensors wake: the last known position, or
    // the first old fix a sensor hands over (the phone's own last known).
    const last = selfPosition.lastKnown?.();
    let previewed = Boolean(last);
    if (last) fly(last, 1.2, { coarse: true });
    set('locating', 'LOCATING');
    const startView = camera.getView();
    const unsubPreview = previewed
      ? null
      : selfPosition.subscribe((f2) => {
          if (previewed || state !== 'locating' || now() - f2.t < FRESH_MS) return;
          if (!sameView(camera.getView(), startView)) return; // the user is looking elsewhere
          previewed = true;
          fly(f2, 1.2, { coarse: true });
        });
    const found = await selfPosition.locate({ timeoutMs });
    unsubPreview?.();
    if (!found) {
      const why = selfPosition.status?.() === 'denied' ? 'DENIED' : 'NO FIX';
      try {
        log?.({
          level: 'warn',
          source: 'GEO',
          title: why === 'DENIED' ? 'LOCATION DENIED' : 'NO POSITION',
          body:
            why === 'DENIED'
              ? 'Location access is off for this page.'
              : 'The device reported no position in time.',
        });
      } catch {
        // logging is best effort
      }
      set('error', why);
      return;
    }
    // The user took the view while it searched: do not yank it back.
    const moved =
      cancelled ||
      (landed !== null && userMoved()) ||
      (!previewed && !sameView(camera.getView(), startView));
    const fresh = now() - found.t < FRESH_MS;
    const text = fresh ? accuracyNote(found) : 'LAST KNOWN';
    if (moved) {
      set('idle', text);
      return;
    }
    set('centered', text);
    const near =
      landed &&
      distanceM({ lat: landed.latitude, lon: landed.longitude }, found) <
        altitudeFor(found, { min: minAltitude }) * 4;
    const ok = await fly(found, near ? 0.6 : 1.2);
    if (ok && state === 'centered') follow(text);
    watchRefine();
  }

  return {
    press,
    /** RECENTER (the chip beside the cell): a paused follow-me takes the camera back. */
    recenter() {
      if (followNow().paused) selfPosition.recenter?.();
    },
    get state() {
      return state;
    },
    /** fn({ state, note }) now and on every change; returns an unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      fn({ state, note });
      return () => listeners.delete(fn);
    },
    destroy() {
      clearTimeout(holdTimer);
      clearTimeout(errorTimer);
      unsubFix?.();
      listeners.clear();
    },
  };
}

/**
 * "Around Me": fly to the user at a regional height. The last known position
 * at once when there is no recent fix, then onto the fresh one. Resolves the
 * fix (or null).
 */
export async function flyToSelf(
  selfPosition,
  camera,
  { altitude = 120_000, timeoutMs = 12_000 } = {},
) {
  if (!selfPosition) return null;
  const go = (fix, duration) =>
    camera.flyTo({ longitude: fix.lon, latitude: fix.lat, altitude, duration });
  const fix = selfPosition.get();
  if (fix && Date.now() - fix.t < FRESH_MS) {
    go(fix, 1.2);
    return fix;
  }
  const last = selfPosition.lastKnown?.();
  if (last) go(last, 1.5);
  const found = await selfPosition.locate({ timeoutMs });
  // Only a real move is worth a second flight at this height.
  if (found && (!last || distanceM(last, found) > altitude * 0.05)) go(found, 1.2);
  return found;
}
