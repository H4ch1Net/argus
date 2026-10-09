import { DEFAULT_SELF_ICON, SELF_ICONS, isSelfIcon } from '../ui/selfIcons.js';

// The user's own position: one model every shell feeds and draws from.
//
// Sources, opened only while something needs them (GEO, follow-me, Around Me,
// navigation) and never while the page is hidden:
//   - the Android app's native GPS (MainActivity: LocationManager GPS and
//     network, pushed into window.argusHost.location), when the page runs in
//     the app; the WebView's own geolocation is slow and coarse there;
//   - otherwise the browser: watchPosition at high accuracy, plus one quick
//     low-accuracy getCurrentPosition in parallel so the first fix is fast;
//   - anything a shell pushes (the car feed, a compass heading).
// Sensors stay shell inputs (CLAUDE.md): nothing here runs at boot, a shell or
// main opens it, and every source is injectable.
//
// Fixes go through a filter (implausible jumps rejected using accuracy and
// time, a worse fix never overrides a better recent one, a still receiver
// settles instead of creeping) and the last fix is kept on this device so GEO
// can fly at once on the next launch. Drawing (the marker, the accuracy ring,
// the locating pulse, follow-me) lives in selfMarker.js, loaded on demand so
// this module stays free of Cesium and testable.

export const FRESH_MS = 30_000; // a fix younger than this is "live"
const GET_MAX_AGE_MS = 5 * 60_000; // get() never hands out an older fix
const CACHE_KEY = 'argus.selfFix';
const CACHE_MAX_AGE_MS = 7 * 24 * 3600_000; // the last known fix, kept a week
const CACHE_EVERY_MS = 15_000;
const MAX_SPEED_MPS = 90; // faster than any car: a jump beyond this is a glitch
const STILL_MPS = 0.6; // below this the receiver is treated as stationary
const COURSE_MPS = 1.2; // above this the course is trusted for the heading
const DEFAULT_ACCURACY_M = 50;
const JUMP_CONSENSUS = 3; // agreeing fixes that overrule an implausible jump
const COMPASS_FRESH_MS = 3000;

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** Great-circle distance in metres. */
export function distanceM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a, b) {
  const p1 = rad(a.lat);
  const p2 = rad(b.lat);
  const dl = rad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * A raw reading as a fix, or null when it is not a position: { lat, lon,
 * accuracy, heading, speed, t, source, alt? }. A missing time is now; a time
 * from the future (a skewed clock) is clamped to now.
 */
export function normalizeFix(raw, now = Date.now()) {
  if (!raw || !finite(raw.lat) || !finite(raw.lon)) return null;
  if (Math.abs(raw.lat) > 90 || Math.abs(raw.lon) > 180) return null;
  if (raw.lat === 0 && raw.lon === 0) return null; // "null island": no fix
  const t = finite(raw.t) ? Math.min(raw.t, now) : now;
  const fix = {
    lat: raw.lat,
    lon: raw.lon,
    accuracy: finite(raw.accuracy) && raw.accuracy > 0 ? raw.accuracy : null,
    heading: finite(raw.heading) && raw.heading >= 0 ? raw.heading % 360 : null,
    speed: finite(raw.speed) && raw.speed >= 0 ? raw.speed : null,
    t,
    source: typeof raw.source === 'string' ? raw.source : 'shell',
  };
  if (finite(raw.alt)) fix.alt = raw.alt;
  return fix;
}

const acc = (f) => f.accuracy ?? DEFAULT_ACCURACY_M;

/**
 * The fix filter. push(fix) -> { accepted, reason?, fix? } where fix is the
 * settled fix to show: a stationary receiver keeps its anchor while new fixes
 * fall inside the noise (it moves only for a clearly better fix), a moving one
 * follows every accepted fix. Heading from the course when moving (the
 * reported one, else the bearing between fixes); null when still.
 */
export function createFixFilter({ maxSpeed = MAX_SPEED_MPS } = {}) {
  let prev = null; // the last accepted raw fix
  let anchor = null; // the settled position shown
  let jump = null; // the last rejected jump, and how many agree with it
  let streak = 0;

  function accept(next, prevRaw) {
    let speed = next.speed;
    let heading = null;
    if (prevRaw) {
      const dt = Math.max(0.001, (next.t - prevRaw.t) / 1000);
      const d = distanceM(prevRaw, next);
      // Derived speed only when the move is clearly more than the noise.
      if (speed === null) speed = d > (acc(prevRaw) + acc(next)) * 0.5 ? d / dt : 0;
      if (next.heading !== null && speed > COURSE_MPS) heading = next.heading;
      else if (speed > COURSE_MPS && d > Math.max(3, Math.min(acc(prevRaw), acc(next))))
        heading = bearingDeg(prevRaw, next);
    } else if (next.heading !== null && (speed ?? 0) > COURSE_MPS) {
      heading = next.heading;
    }
    speed ??= 0;
    const moving = speed >= STILL_MPS;
    if (anchor && !moving) {
      const band = Math.max(3, 0.8 * Math.min(acc(anchor), acc(next)));
      const inside = distanceM(anchor, next) <= band;
      if (!inside || acc(next) < acc(anchor) * 0.7) anchor = next;
    } else {
      anchor = next;
    }
    prev = next;
    jump = null;
    streak = 0;
    const out = {
      lat: anchor.lat,
      lon: anchor.lon,
      accuracy: next.accuracy,
      heading,
      speed,
      t: next.t,
      source: next.source,
    };
    if (finite(next.alt)) out.alt = next.alt;
    return { accepted: true, fix: out };
  }

  return {
    push(next) {
      if (!next) return { accepted: false, reason: 'invalid' };
      // Anything from a past session is a starting guess, not evidence.
      if (!prev || prev.source === 'cache') return accept(next, null);
      if (next.t < prev.t) return { accepted: false, reason: 'old' };
      if (next.t === prev.t && acc(next) >= acc(prev))
        return { accepted: false, reason: 'dup' };
      const dt = Math.max(0.001, (next.t - prev.t) / 1000);
      // A worse fix while a better one is still good (two sources racing,
      // network after GPS): the better fix's uncertainty grows with time at
      // walking pace, or its own speed, until the worse one wins.
      const grown = acc(prev) + Math.max(1.5, prev.speedSeen ?? 0) * dt;
      if (acc(next) > grown && acc(next) > acc(prev) * 1.5)
        return { accepted: false, reason: 'worse' };
      // An implausible jump: farther than both uncertainties plus the fastest
      // plausible travel. Rejected unless several fixes in a row agree on the
      // new place (then the old fix was the wrong one).
      const allowed = acc(prev) + acc(next) + maxSpeed * dt + 20;
      if (distanceM(prev, next) > allowed) {
        if (
          jump &&
          distanceM(jump, next) <=
            acc(jump) +
              acc(next) +
              maxSpeed * Math.max(0.001, (next.t - jump.t) / 1000) +
              20
        ) {
          streak += 1;
        } else {
          streak = 1;
        }
        jump = next;
        if (streak < JUMP_CONSENSUS) return { accepted: false, reason: 'jump' };
      }
      const res = accept(next, prev);
      prev.speedSeen = res.fix.speed;
      return res;
    },
    reset() {
      prev = anchor = jump = null;
      streak = 0;
    },
  };
}

// ------------------------------------------------------------------ store

function readCache(storage, now) {
  try {
    const raw = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null');
    const fix = normalizeFix({ ...raw, source: 'cache' }, now);
    if (!fix || !finite(raw?.t) || now - raw.t > CACHE_MAX_AGE_MS) return null;
    return fix;
  } catch {
    return null;
  }
}

function writeCache(storage, fix) {
  try {
    storage?.setItem(
      CACHE_KEY,
      JSON.stringify({
        lat: Math.round(fix.lat * 1e6) / 1e6,
        lon: Math.round(fix.lon * 1e6) / 1e6,
        accuracy: fix.accuracy === null ? null : Math.round(fix.accuracy),
        t: fix.t,
      }),
    );
  } catch {
    // private mode or full storage: the fix still applies this session
  }
}

const angleDelta = (a, b) => ((b - a + 540) % 360) - 180;

// ---------------------------------------------------------------- sources

/**
 * The browser's geolocation: a high-accuracy watch plus one quick coarse read.
 * A still desktop's watch can go quiet (it answers only on a change), so while
 * open it asks again when nothing came for 20 s, and poke() asks at once.
 */
function browserSource(geo, { onFix, onError, now }) {
  let watchId = null;
  let keepAlive = null;
  let lastAt = 0;
  const toFix = (p) => ({
    lat: p.coords.latitude,
    lon: p.coords.longitude,
    accuracy: p.coords.accuracy,
    heading: p.coords.heading,
    speed: p.coords.speed,
    alt: p.coords.altitude,
    t: p.timestamp,
    source: 'browser',
  });
  const got = (p) => {
    lastAt = now();
    onFix(toFix(p));
  };
  const read = (opts) =>
    geo.getCurrentPosition?.(
      got,
      (e) => e?.code === 1 && onError('denied', e?.message),
      opts,
    );
  return {
    available: Boolean(geo && typeof geo.watchPosition === 'function'),
    open() {
      if (watchId !== null) return;
      lastAt = now();
      watchId = geo.watchPosition(
        got,
        (e) => onError(e?.code === 1 ? 'denied' : 'unavailable', e?.message),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
      );
      // A cached or network position answers in a moment; the GPS refines it.
      read({ enableHighAccuracy: false, maximumAge: 300_000, timeout: 5000 });
      keepAlive = setInterval(() => {
        if (now() - lastAt > 20_000)
          read({ enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 });
      }, 10_000);
    },
    poke() {
      if (watchId !== null)
        read({ enableHighAccuracy: true, maximumAge: 5000, timeout: 15_000 });
    },
    close() {
      if (watchId !== null) geo.clearWatch?.(watchId);
      watchId = null;
      clearInterval(keepAlive);
      keepAlive = null;
    },
  };
}

/** The Android app's native GPS (window.ArgusAndroid), when the page runs in it. */
function nativeSource(host) {
  const ok =
    host &&
    typeof host.startLocation === 'function' &&
    typeof host.stopLocation === 'function';
  let open = false;
  const call = (fn) => {
    try {
      fn();
    } catch {
      // the bridge went away with the activity: nothing to do
    }
  };
  return {
    available: Boolean(ok),
    failed: false, // the app has no provider at all: use the browser instead
    open() {
      if (open) return;
      open = true;
      call(() => host.startLocation());
    },
    /** A new page starts with the app's feed off (a reload may leave it on). */
    reset() {
      open = false;
      if (ok) call(() => host.stopLocation());
    },
    close() {
      if (!open) return;
      open = false;
      call(() => host.stopLocation());
    },
  };
}

// ------------------------------------------------------------------ model

/**
 * @param {import('cesium').Viewer|null} viewer  null: the model only (tests, workers)
 * @param {{ settings?: object, render?: boolean, geolocation?: object|null,
 *   host?: object|null, storage?: Storage|null, now?: () => number,
 *   log?: (entry: object) => void, fps?: number, onIcon?: (id: string) => void,
 *   doc?: Document|null }} [opts]
 */
export function createSelfPosition(viewer, opts = {}) {
  const {
    settings = null,
    render = true,
    geolocation = typeof navigator !== 'undefined' ? navigator.geolocation : null,
    host = typeof window !== 'undefined' ? window.ArgusAndroid : null,
    storage = defaultStorage(),
    now = () => Date.now(),
    log = null,
    fps = 30,
    onIcon = null,
    doc = typeof document !== 'undefined' ? document : null,
  } = opts;

  const filter = createFixFilter();
  const fixListeners = new Set();
  const stateListeners = new Set();
  const holders = new Set();
  let last = readCache(storage, now()); // the last known fix (maybe old)
  let current = null; // the newest accepted fix of this session
  let courseHeading = null;
  let compass = null; // { heading, at }
  let status = 'idle'; // idle | live | stale | denied | unavailable
  let sensing = false;
  let hidden = Boolean(doc?.hidden);
  let cachedAt = 0;
  let staleTimer = null;
  let pending = null; // { promise, resolve, timer }
  let marker = null;
  let following = false;
  let icon = isSelfIcon(settings?.get?.('selfIcon'))
    ? settings.get('selfIcon')
    : DEFAULT_SELF_ICON;
  const logged = new Set();

  const note = (level, title, body) => {
    // One entry per kind of trouble a session, not one per failed read.
    if (logged.has(title)) return;
    logged.add(title);
    try {
      log?.({ level, source: 'GEO', title, body });
    } catch {
      // a log that throws is not our problem
    }
    if (level !== 'info') console.warn(`[argus] ${title}${body ? `: ${body}` : ''}`);
  };

  // --------------------------------------------------------------- sources
  const native = nativeSource(host);
  const browser = browserSource(geolocation, {
    onFix: (f) => api.push(f),
    onError: (kind, msg) => sourceError(kind, msg),
    now,
  });

  function sourceError(kind, msg) {
    if (kind === 'denied') {
      setStatus('denied');
      closeSources();
      note('warn', 'LOCATION DENIED', 'This page may not read the device position.');
      settle(null);
    } else {
      // Timeouts and "unavailable" are transient: the watch keeps trying.
      note('info', 'LOCATION SLOW', msg || 'No position from the device yet.');
    }
  }

  function openSources() {
    if (sensing) return;
    if (native.available && !native.failed) native.open();
    else if (browser.available) browser.open();
    else {
      setStatus('unavailable');
      note(
        'warn',
        'NO LOCATION SENSOR',
        'This browser offers no geolocation (a phone needs HTTPS).',
      );
      settle(null);
      return;
    }
    sensing = true;
    emitState();
  }

  function closeSources() {
    native.close();
    browser.close();
    if (!sensing) return;
    sensing = false;
    if (current) writeCache(storage, current);
    emitState();
    refreshStatus();
  }

  function sync() {
    const want = holders.size > 0 && !hidden && status !== 'denied';
    if (want) openSources();
    else closeSources();
  }

  // The Android app calls these (MainActivity.pushFix / pushStatus).
  if (typeof window !== 'undefined' && native.available) {
    const bridge = (window.argusHost ??= {});
    bridge.location = (lat, lon, heading, speed, accuracy, t, provider) =>
      api.push({
        lat,
        lon,
        heading,
        speed,
        accuracy,
        t,
        source: typeof provider === 'string' ? provider : 'native',
      });
    bridge.locationStatus = (s) => {
      if (s === 'denied') sourceError('denied');
      else if (s === 'off')
        note('warn', 'LOCATION OFF', 'Location is switched off in the phone settings.');
      else if (s === 'unavailable' && !native.failed) {
        // No GPS or network provider in the app: the WebView's own geolocation.
        native.failed = true;
        native.close();
        if (sensing) {
          sensing = false;
          openSources();
        }
      }
    };
    native.reset();
  }

  // Nothing senses while the page is in the background.
  const onVisibility = () => {
    hidden = Boolean(doc?.hidden);
    if (hidden && current) writeCache(storage, current);
    sync();
  };
  doc?.addEventListener?.('visibilitychange', onVisibility);

  // ---------------------------------------------------------------- state
  function setStatus(s) {
    if (status === s) return;
    status = s;
    emitState();
  }

  function refreshStatus() {
    clearTimeout(staleTimer);
    staleTimer = null;
    if (status === 'denied' || status === 'unavailable') return;
    const fix = current;
    if (!fix) return setStatus('idle');
    const age = now() - fix.t;
    if (age < FRESH_MS) {
      setStatus('live');
      staleTimer = setTimeout(refreshStatus, FRESH_MS - age + 50);
    } else {
      setStatus('stale');
    }
    paintMarker();
  }

  function stateNow() {
    return { status, sensing, following, locating: Boolean(pending) };
  }

  function emitState() {
    const s = stateNow();
    for (const fn of stateListeners) {
      try {
        fn(s);
      } catch (e) {
        console.warn('[argus] self position listener failed', e);
      }
    }
    paintMarker();
  }

  function headingNow() {
    const moving = (current?.speed ?? 0) > COURSE_MPS && current?.heading !== null;
    if (moving) return current.heading;
    if (compass && now() - compass.at < COMPASS_FRESH_MS) return compass.heading;
    return courseHeading;
  }

  function withHeading(fix) {
    return fix ? { ...fix, heading: headingNow() } : null;
  }

  function settle(fix) {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimeout(p.timer);
    p.resolve(fix);
    api.stop('locate');
    emitState();
  }

  // --------------------------------------------------------------- marker
  function paintMarker() {
    if (!marker) return;
    const fix = current ?? last;
    marker.update({
      fix: fix ? withHeading(fix) : null,
      live: status === 'live',
      locating: Boolean(pending),
    });
  }

  if (viewer && render) {
    import('./selfMarker.js')
      .then(({ createSelfMarker }) => {
        marker = createSelfMarker(viewer, {
          icon,
          fps,
          onFollow: (on) => {
            following = on;
            emitState();
          },
        });
        paintMarker();
      })
      .catch((e) => console.warn('[argus] own-position marker unavailable', e));
  }

  // -------------------------------------------------------------- settings
  const applyIcon = (id) => {
    icon = isSelfIcon(id) ? id : DEFAULT_SELF_ICON;
    marker?.setIcon(icon);
    try {
      onIcon?.(icon);
    } catch (e) {
      console.warn('[argus] self icon hook failed', e);
    }
  };
  settings?.subscribe?.((key, value) => key === 'selfIcon' && applyIcon(value));
  if (onIcon) applyIcon(icon);

  // ------------------------------------------------------------------ api
  const api = {
    icons: SELF_ICONS.map(({ id, label }) => ({ id, label })),

    /** The newest fix (at most five minutes old), with the best heading; else null. */
    get() {
      const fix = current ?? last;
      if (!fix || now() - fix.t > GET_MAX_AGE_MS) return null;
      return withHeading(fix);
    },

    /** The last known fix however old (a previous session's included); else null. */
    lastKnown: () => withHeading(current ?? last),

    /** fn(fix) on every accepted fix; returns an unsubscribe. */
    subscribe(fn) {
      fixListeners.add(fn);
      return () => fixListeners.delete(fn);
    },

    /** fn({ status, sensing, following, locating }) on every state change. */
    watch(fn) {
      stateListeners.add(fn);
      fn(stateNow());
      return () => stateListeners.delete(fn);
    },

    status: () => status,
    get following() {
      return following;
    },

    /** Keep the sensors open for an owner ('default' when none is given). */
    start(owner = 'default') {
      holders.add(owner);
      sync();
    },

    /** Release an owner's hold; the sensors close when nobody holds them. */
    stop(owner = 'default') {
      holders.delete(owner);
      sync();
    },

    /**
     * A recent fix at once (younger than FRESH_MS), else the first fresh fix
     * from the sensors. On timeout: the coarse fix this session had, else the
     * last known one, else null. Null at once when location is refused.
     */
    locate({ timeoutMs = 10_000 } = {}) {
      const fix = current;
      if (fix && now() - fix.t < FRESH_MS) return Promise.resolve(withHeading(fix));
      if (pending) return pending.promise;
      // A new request is a new chance: the user may have allowed it since.
      if (status === 'denied' || status === 'unavailable')
        status = current ? 'stale' : 'idle';
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      pending = { promise, resolve, timer: null };
      pending.timer = setTimeout(() => {
        note(
          'info',
          'LOCATION TIMEOUT',
          'No fresh fix in time: using the last known position.',
        );
        settle(withHeading(current ?? last));
      }, timeoutMs);
      emitState();
      const wasSensing = sensing;
      api.start('locate');
      // Already open (a quiet watch): ask for a new reading now. The app's
      // native feed needs no nudge: it reports every second.
      if (wasSensing && (!native.available || native.failed)) browser.poke();
      if (status === 'denied' || status === 'unavailable') settle(null);
      return promise;
    },

    /**
     * A fix from a feed (the Android app, the car, a shell): { lat, lon,
     * accuracy?, heading?, speed?, t?, source? }. Returns true when accepted.
     */
    push(raw) {
      const fix = normalizeFix(raw, now());
      const res = filter.push(fix);
      if (!res.accepted) return false;
      current = res.fix;
      if (res.fix.heading !== null) courseHeading = res.fix.heading;
      if (status === 'denied' || status === 'unavailable') status = 'idle';
      const t = now();
      if (t - cachedAt > CACHE_EVERY_MS) {
        cachedAt = t;
        writeCache(storage, current);
      }
      const out = withHeading(current);
      for (const fn of fixListeners) {
        try {
          fn(out);
        } catch (e) {
          console.warn('[argus] self position subscriber failed', e);
        }
      }
      if (pending && t - current.t < FRESH_MS) settle(out);
      refreshStatus();
      paintMarker();
      return true;
    },

    /** A compass heading from a shell (degrees, null when gone): used while still. */
    setCompass(heading) {
      if (!finite(heading)) {
        compass = null;
        return;
      }
      const h = ((heading % 360) + 360) % 360;
      // Small wobbles redraw nothing.
      if (
        compass &&
        Math.abs(angleDelta(compass.heading, h)) < 2 &&
        now() - compass.at < 1000
      )
        return;
      compass = { heading: h, at: now() };
      paintMarker();
    },

    /** Follow-me: the camera rides with the marker. Returns whether it is on. */
    follow(on = true) {
      if (!marker) return false;
      const ok = marker.follow(Boolean(on) && Boolean(current ?? last));
      if (ok !== following) {
        following = ok;
        emitState();
      }
      return ok;
    },

    setIcon(id) {
      if (settings?.set)
        settings.set('selfIcon', isSelfIcon(id) ? id : DEFAULT_SELF_ICON);
      else applyIcon(id);
    },
    get icon() {
      return icon;
    },

    destroy() {
      holders.clear();
      closeSources();
      clearTimeout(staleTimer);
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      marker?.destroy();
      marker = null;
    },
  };
  return api;
}

function defaultStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
