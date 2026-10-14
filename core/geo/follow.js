// Follow-me the way a map app does it. Pure: core/geo/selfPosition.js holds
// one, core/geo/selfMarker.js moves the camera from it, GEO cycles it.
//
//   off      the camera is free
//   follow   the camera keeps the marker in view, the map turned wherever
//            the user left it (north up unless they twisted it)
//   heading  the same, with the map turned so the way you travel is up
//
// A drag on the map pauses following (the RECENTER chip shows); a pinch or a
// twist does not: zooming changes the follow distance, and a twist while
// heading-up drops to plain follow with the user's own heading. While paused,
// travelling faster than RESUME_MPS with the map untouched for RESUME_MS
// resumes on its own, as a car navigator does.

export const FOLLOW_MODES = Object.freeze(['off', 'follow', 'heading']);
export const RESUME_MS = 10_000;
export const RESUME_MPS = 3;

/**
 * @param {{ now?: () => number, resumeMs?: number, resumeMps?: number }} [opts]
 */
export function createFollowState({
  now = () => Date.now(),
  resumeMs = RESUME_MS,
  resumeMps = RESUME_MPS,
} = {}) {
  let mode = 'off';
  let paused = false;
  let touchedAt = -Infinity;
  const listeners = new Set();

  const snapshot = () => ({ mode, paused, active: mode !== 'off' && !paused });

  function set(next, pause = false) {
    const m = FOLLOW_MODES.includes(next) ? next : 'off';
    const p = m !== 'off' && Boolean(pause);
    if (m === mode && p === paused) return false;
    mode = m;
    paused = p;
    const s = snapshot();
    for (const fn of listeners) fn(s);
    return true;
  }

  return {
    get mode() {
      return mode;
    },
    get paused() {
      return paused;
    },
    /** Following and not paused: the camera should ride with the marker. */
    get active() {
      return mode !== 'off' && !paused;
    },
    state: snapshot,

    /** Follow in a mode ('follow' or 'heading'), or 'off'. Clears a pause. */
    set(next) {
      set(next);
      return mode;
    },

    /** GEO's tap: paused resumes; off follows; follow turns heading-up; heading-up ends. */
    cycle() {
      if (mode !== 'off' && paused) set(mode);
      else set(mode === 'off' ? 'follow' : mode === 'follow' ? 'heading' : 'off');
      return mode;
    },

    /** RECENTER: back to following in the same mode. */
    resume() {
      if (mode !== 'off' && paused) set(mode);
    },

    /** The user dragged the map, or the camera was sent elsewhere: pause. */
    drag() {
      touchedAt = now();
      if (mode !== 'off' && !paused) set(mode, true);
    },

    /** Any touch on the map: while paused it restarts the wait before resuming. */
    touch() {
      touchedAt = now();
    },

    /** A twist of the map while heading-up: keep following, with the user's heading. */
    twist() {
      touchedAt = now();
      if (mode === 'heading' && !paused) set('follow');
    },

    /**
     * A new fix at this speed (m/s): a pause ends on its own when travelling
     * and the map has been left alone long enough. True when it resumed.
     */
    fix(speed) {
      if (mode === 'off' || !paused) return false;
      if (!(speed >= resumeMps) || now() - touchedAt < resumeMs) return false;
      set(mode);
      return true;
    },

    /** fn({ mode, paused, active }) after every change; returns an unsubscribe. */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
