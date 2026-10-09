// Where the user is, for navigation: the app's self position
// (core/geo/selfPosition.js, app.selfPosition: the phone's GPS, the car's
// location pushed by the Android app) when there is one, else the browser's
// own geolocation. Browser APIs only (no Cesium); every call is defensive, so
// it works before or without the self-position module.
//
// Fix = { lat, lon, accuracy, heading, speed, t, source }.

const num = (v) => (Number.isFinite(v) ? v : null);

function fromPosition(p) {
  const c = p?.coords;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;
  return {
    lat: c.latitude,
    lon: c.longitude,
    accuracy: num(c.accuracy),
    heading: num(c.heading),
    speed: num(c.speed),
    t: Number.isFinite(p.timestamp) ? p.timestamp : Date.now(),
    source: 'geolocation',
  };
}

/**
 * @param {{ selfPosition?: object|null, geolocation?: Geolocation|null }} [opts]
 */
export function createFixSource({
  selfPosition = null,
  geolocation = globalThis.navigator?.geolocation ?? null,
} = {}) {
  let last = null;
  const self = () => (typeof selfPosition === 'function' ? selfPosition() : selfPosition);
  const keep = (fix) => {
    if (fix && Number.isFinite(fix.lat) && Number.isFinite(fix.lon)) last = fix;
    return fix;
  };

  return {
    /** The latest known fix, or null. */
    get() {
      const s = self()?.get?.();
      return s ? keep(s) : last;
    },
    /** A fix now if one is known, else the first one within `timeoutMs` (or null). */
    async locate({ timeoutMs = 8000 } = {}) {
      const sp = self();
      if (sp?.locate) {
        try {
          const f = await sp.locate({ timeoutMs });
          if (f) return keep(f);
        } catch {
          // fall through to the browser
        }
      }
      if (!geolocation) return last;
      return new Promise((resolve) => {
        geolocation.getCurrentPosition(
          (p) => resolve(keep(fromPosition(p)) ?? last),
          () => resolve(last),
          { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15_000 },
        );
      });
    },
    /**
     * Stream fixes to `fn` until the returned function is called. The self
     * position is started (and left to its owner to stop); the browser watch
     * is cleared.
     */
    watch(fn) {
      const sp = self();
      if (sp?.subscribe) {
        try {
          sp.start?.();
        } catch {
          // already running, or not startable here
        }
        const off = sp.subscribe((f) => f && fn(keep(f)));
        return () => off?.();
      }
      if (!geolocation?.watchPosition) return () => {};
      const id = geolocation.watchPosition(
        (p) => {
          const f = keep(fromPosition(p));
          if (f) fn(f);
        },
        (err) => console.warn('[argus] nav: location unavailable', err?.message ?? err),
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
      );
      return () => geolocation.clearWatch(id);
    },
    /** True when the app's self position (not the browser fallback) is in use. */
    get native() {
      return Boolean(self()?.subscribe);
    },
  };
}
