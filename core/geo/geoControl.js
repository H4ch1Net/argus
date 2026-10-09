import { formatDistance } from '../settings/store.js';
import { FRESH_MS, distanceM } from './selfPosition.js';

// GEO: the view stack's "centre on me" cell, the same on phone and desktop.
//
//   tap 1  a fix younger than 30 s: a short flight there at once. Otherwise
//          the last known position (this device remembers it) at once while
//          the cell shows LOCATING, then a short hop onto the first fresh fix.
//          A coarse first fix is refined: for 20 s, a better fix that lands
//          off-centre re-centres, unless the user has moved the view.
//   tap 2  (the view still where GEO left it) follow-me: the camera rides with
//          the marker. tap 3 ends it.
// Failures are a state on the cell plus one log entry, never a popup. The
// sensors stay open while GEO is in use and for three minutes after, then
// close (follow-me holds them for as long as it lasts).

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

/**
 * @param {{ selfPosition: object, camera: { flyAround: Function, getView: Function },
 *   timeoutMs?: number, holdMs?: number, minAltitude?: number,
 *   beforeFollow?: () => void, log?: (entry: object) => void, now?: () => number,
 *   units?: () => string }} deps  units: the settings' unit system, for the notes
 */
export function createGeoControl({
  selfPosition,
  camera,
  timeoutMs = 12_000,
  holdMs = HOLD_MS,
  minAltitude = 1800,
  beforeFollow,
  log,
  now = () => Date.now(),
  units = () => 'metric',
}) {
  const listeners = new Set();
  let state = 'idle'; // idle | locating | centered | following | error
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
    holdTimer = setTimeout(() => {
      if (state !== 'following') selfPosition.stop('geo');
    }, holdMs);
  }

  // Follow-me ends elsewhere (FOLLOW on a contact, cockpit, a drag in some
  // builds): the cell drops back, and the hold runs out from here.
  selfPosition.watch?.((s) => {
    if (state === 'following' && !s.following) {
      set('idle');
      hold();
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

  // A better fix after a coarse one: hop onto it while the view is untouched.
  function watchRefine() {
    unsubFix?.();
    refineUntil = now() + REFINE_MS;
    unsubFix = selfPosition.subscribe((fix) => {
      if (now() > refineUntil || state !== 'centered') {
        unsubFix?.();
        unsubFix = null;
        return;
      }
      if (!landed || userMoved()) return;
      const off = distanceM(
        { lat: landed.latitude, lon: landed.longitude },
        { lat: fix.lat, lon: fix.lon },
      );
      if (off > Math.max(30, altitudeFor(fix, { min: minAltitude }) * 0.12)) {
        fly(fix, 0.7);
        set('centered', accuracyNote(fix));
      }
    });
  }

  async function press() {
    if (state === 'locating') return;
    if (state === 'following') {
      set('centered', '');
      selfPosition.follow(false);
      hold();
      return;
    }
    if (state === 'centered' && landed && !userMoved()) {
      beforeFollow?.();
      if (selfPosition.follow(true)) {
        clearTimeout(holdTimer);
        selfPosition.start('geo');
        set('following', 'FOLLOW');
        return;
      }
    }
    hold();
    landed = null;
    cancelled = false;
    const fix = selfPosition.get();
    if (fix && now() - fix.t < FRESH_MS) {
      set('centered', accuracyNote(fix));
      await fly(fix, 0.8);
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
      : selfPosition.subscribe((f) => {
          if (previewed || state !== 'locating' || now() - f.t < FRESH_MS) return;
          if (!sameView(camera.getView(), startView)) return; // the user is looking elsewhere
          previewed = true;
          fly(f, 1.2, { coarse: true });
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
    if (moved) {
      set('idle', fresh ? accuracyNote(found) : 'LAST KNOWN');
      return;
    }
    set('centered', fresh ? accuracyNote(found) : 'LAST KNOWN');
    const near =
      landed &&
      distanceM({ lat: landed.latitude, lon: landed.longitude }, found) <
        altitudeFor(found, { min: minAltitude }) * 4;
    await fly(found, near ? 0.6 : 1.2);
    watchRefine();
  }

  return {
    press,
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
