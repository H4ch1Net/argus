// The observed-weather timeline: one clock for every weather overlay, so radar,
// infrared and lightning step back through the last hours together. No DOM, no
// Cesium: the UI strip drives it (setTarget, step, latest, play, pause) and
// reads it (getState, subscribe); each weather layer's source asks frameFor().
//
// Adapted from gods-eye-view src/layers/weather/clock.js (MIT). Two modes:
//   'latest'  each product shows its newest advertised frame (live);
//   'history' a target time; each product shows its newest frame at or before
//             the target within its own max gap (selectFrame), or nothing.
// Play steps through the union of all products' times, one frame every
// `frameMs` (2 s), looping, and stops if fewer than two times remain. Each
// overlay reports the frame it actually has on screen (markShown, called by
// the raster engine through the timed source); play holds a frame until every
// overlay shows it, for at most `maxWaitMs`, so a slow network slows the loop
// instead of skipping frames that never got the chance to appear.

import { selectFrame, unionTimeline, isoInstant } from './capabilities.js';

export const FRAME_MS = 2000;

const POLL_MS = 250;

/**
 * @param {{ frameMs?: number, maxWaitMs?: number, setTimeout?: Function,
 *   clearTimeout?: Function }} [opts]
 */
export function createWeatherTimeline({
  frameMs = FRAME_MS,
  maxWaitMs = 4 * FRAME_MS,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
} = {}) {
  const products = new Map(); // id -> { times: string[], maxGapMs, refs, shown }
  const listeners = new Set();
  let mode = 'latest';
  let target = null;
  let playing = false;
  let timer = null;
  let destroyed = false;

  const getTimeline = () => unionTimeline([...products.values()].map((p) => p.times));

  /**
   * The frame a product should show now: { time, live }. live (latest mode)
   * with no time means "untimed latest"; not live with no time means "nothing
   * near the target: hide".
   */
  function frameFor(id) {
    const p = products.get(id);
    const times = p?.times ?? [];
    if (mode === 'latest') return { time: times[times.length - 1] ?? null, live: true };
    return { time: p ? selectFrame(times, target, p.maxGapMs) : null, live: false };
  }

  // Every overlay shows the frame the timeline selects for it.
  function framesShown() {
    for (const [id, p] of products) {
      const want = frameFor(id).time;
      if (want && p.shown !== want) return false;
    }
    return true;
  }

  function getState() {
    const frames = {};
    const shown = {};
    for (const [id, p] of products) {
      frames[id] = frameFor(id).time;
      shown[id] = p.shown ?? null;
    }
    return {
      mode,
      target,
      playing,
      timeline: getTimeline(),
      frames,
      shown,
      loading: !framesShown(),
    };
  }

  function notify() {
    if (destroyed) return;
    const state = getState();
    for (const fn of [...listeners]) fn(state);
  }

  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    cancel();
    if (!playing || destroyed) return;
    let waited = 0;
    const tick = () => {
      timer = null;
      if (!playing || destroyed) return;
      if (!framesShown() && waited < maxWaitMs) {
        waited += POLL_MS;
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      const line = getTimeline();
      if (line.length < 2) {
        api.pause();
        return;
      }
      const at = Date.parse(target);
      const next = line.find((t) => Date.parse(t) > at) ?? line[0];
      moveTo(next);
      schedule();
    };
    timer = setTimeout(tick, frameMs);
  }

  function moveTo(time) {
    mode = 'history';
    target = time;
    notify();
  }

  const api = {
    getTimeline,
    getState,
    frameFor,

    /**
     * Join the timeline (a weather layer turning on). Returns a function that
     * leaves it. A product registered twice is shared, not duplicated.
     */
    register(id, { maxGapMs = 30 * 60_000, times = [] } = {}) {
      if (destroyed) return () => {};
      let p = products.get(id);
      if (p) p.refs++;
      else {
        p = { times: unionTimeline([times]), maxGapMs, refs: 1, shown: undefined };
        products.set(id, p);
        notify();
      }
      let left = false;
      return () => {
        if (left || products.get(id) !== p) return;
        left = true;
        if (--p.refs > 0) return;
        products.delete(id);
        if (getTimeline().length < 2 && playing) api.pause();
        notify();
      };
    },

    /** A product's advertised times (from GetCapabilities). */
    setTimes(id, times) {
      const p = products.get(id);
      if (!p || destroyed) return;
      const next = unionTimeline([times]);
      if (next.length === p.times.length && next.every((t, i) => t === p.times[i]))
        return;
      p.times = next;
      notify();
    },

    /** An overlay reports the frame now on screen (null: cleared). */
    markShown(id, time) {
      const p = products.get(id);
      if (!p || destroyed) return;
      const t = time == null ? null : isoInstant(time);
      if (p.shown === t) return;
      p.shown = t;
      notify();
    },

    /** Show the frames at (or just before) this time. */
    setTarget(time) {
      if (destroyed) return false;
      const ms = typeof time === 'number' ? time : Date.parse(time);
      if (!Number.isFinite(ms)) throw new TypeError('weather target must be a UTC time');
      const t = isoInstant(new Date(ms).toISOString());
      if (mode === 'history' && target === t) return true;
      moveTo(t);
      if (playing) schedule();
      return true;
    },

    /** One frame back (-1) or forward (+1) on the union timeline; pauses play. */
    step(direction) {
      if (destroyed || (direction !== -1 && direction !== 1)) return false;
      api.pause();
      const line = getTimeline();
      if (!line.length) return false;
      const at = Date.parse(target ?? line[line.length - 1]);
      const next =
        direction < 0
          ? (line.findLast((t) => Date.parse(t) < at) ?? line[0])
          : (line.find((t) => Date.parse(t) > at) ?? line[line.length - 1]);
      return api.setTarget(next);
    },

    /** Back to live: each product's newest frame. */
    latest() {
      if (destroyed) return;
      cancel();
      mode = 'latest';
      target = null;
      playing = false;
      notify();
    },

    /** Loop through the timeline, starting at the oldest frame from live. */
    play() {
      if (destroyed || playing) return false;
      const line = getTimeline();
      if (line.length < 2) return false;
      playing = true;
      if (mode === 'latest') moveTo(line[0]);
      else notify();
      schedule();
      return true;
    },

    pause() {
      cancel();
      if (!playing) return;
      playing = false;
      notify();
    },

    togglePlay() {
      return playing ? (api.pause(), false) : api.play();
    },

    /** fn(state) on every change; returns an unsubscribe function. */
    subscribe(fn) {
      if (destroyed) return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    destroy() {
      cancel();
      destroyed = true;
      playing = false;
      products.clear();
      listeners.clear();
    },
  };
  return api;
}
