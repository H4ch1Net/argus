// The navigator: search a destination, plan routes, follow one turn by turn.
// One object every shell drives the same way (desktop and phone through
// core/ui/navPanel.js, the car through shell-car, the terminal's `argus
// route`). Pure apart from the injected proxy client and clock: no Cesium, no
// DOM, no timers that outlive a call.
//
//   const nav = createNavigator({ proxyClient });
//   const places = await nav.search('ferry building', { near });
//   const routes = await nav.plan(here, places[0], { mode: 'drive' });
//   nav.start(routes[0]);
//   nav.update(fix);            // every GPS fix
//   nav.subscribe((state) => ...);
//
// Routers (core/nav/providers.js): TomTom with live traffic when the proxy has
// the key and traffic is on (driving), Valhalla to avoid highways, OSRM
// otherwise; each falls back to the next. Routes are ranked by travel time
// plus the expected wait at traffic signals (core/nav/signals.js), counted
// from OSM through the proxy's Overpass feed. Off the route for 3 fixes:
// a new route from where the vehicle is, at most every 10 s.
//
// NavState = { status: 'idle'|'planning'|'previewing'|'navigating'|
//   'rerouting'|'arrived', destination?, routes?, route?, progress?, error? }
// progress = { distanceRemainingM, durationRemainingS, eta, stepIndex,
//   distanceToStepM, step, then?, offRoute, snapped: {lat, lon},
//   signalsAhead?, alongM }

import { PROVIDERS, providerChain, navMode, valhalla } from './providers.js';
import { routeErrorMessage } from '../route/osrm.js';
import { createProgress } from './progress.js';
import { annotateSignals, createSignalCache } from './signals.js';
import { searchDestinations, reverseName, TOMTOM_SEARCH_FEED } from './search.js';

export const REROUTE_GAP_MS = 10_000;
/** A fix older than this is not used to place the vehicle when navigation starts. */
const FIX_FRESH_MS = 30_000;

/** A short ctOS reason for a failed plan. */
export function planErrorMessage(err) {
  const s = Number(err?.status);
  if (err?.code === 'bad-stops') return String(err.message).toUpperCase();
  if (s === 400 || err?.code === 'no-route') return 'NO ROUTE BETWEEN THESE POINTS';
  if (s === 429) return 'ROUTER BUSY: TRY AGAIN SHORTLY';
  if (s === 403) return 'ROUTE REFUSED BY THE PROXY';
  if (s >= 500) return 'ROUTER UNREACHABLE';
  if (err?.code === 'no-proxy') return 'ROUTING NEEDS THE PROXY';
  return 'NO ROUTE';
}

function toPlace(p) {
  const lat = Number(p?.lat ?? p?.latitude);
  const lon = Number(p?.lon ?? p?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    id: p.id ?? `pin:${lat.toFixed(5)},${lon.toFixed(5)}`,
    name: p.name ?? 'DROPPED PIN',
    detail: p.detail ?? '',
    lat,
    lon,
    kind: p.kind ?? 'pin',
  };
}

/** Travel time plus the expected signal wait: what routes are ranked by. */
export const routeCost = (r) => (r?.durationS ?? 0) + (r?.signalDelayS ?? 0);

/**
 * @param {{ proxyClient: { getJson: Function } | null, now?: () => number,
 *   hasFeed?: (id: string) => boolean, signals?: boolean, signalTimeoutMs?: number,
 *   log?: (entry: { level: string, source: string, title: string, body?: string }) => void }} opts
 *   hasFeed: whether the proxy can serve a feed (its /health); without it,
 *   TomTom is tried once and dropped for the session if it is not configured.
 */
export function createNavigator({
  proxyClient,
  now = () => Date.now(),
  hasFeed = null,
  signals = true,
  signalTimeoutMs = 4000,
  log = null,
} = {}) {
  let state = Object.freeze({ status: 'idle' });
  const listeners = new Set();
  let planSeq = 0;
  let navSeq = 0;
  let routeSeq = 0;
  let engine = null;
  let lastOpts = null;
  let lastFix = null;
  let rerouting = false;
  let rerouteAt = -Infinity;
  // TomTom availability: from the proxy's /health when given, else learnt.
  const learnt = { 'tomtom-routing': null, [TOMTOM_SEARCH_FEED]: null };
  const available = (id) =>
    typeof hasFeed === 'function' ? Boolean(hasFeed(id)) : learnt[id] !== false;
  const learn = (id, err) => {
    if (typeof hasFeed !== 'function' && [401, 403, 502].includes(Number(err?.status)))
      learnt[id] = false;
  };
  // Failures go to the given logger (the app's LOGS, the terminal's --verbose),
  // else to the console; never to a popup.
  const note = (level, title, body) => {
    if (!log) {
      console.warn(`[argus] nav: ${title}${body ? `: ${body}` : ''}`);
      return;
    }
    try {
      log({ level, source: 'nav', title, body });
    } catch {
      // a logger must never break navigation
    }
  };

  const signalCache =
    signals && proxyClient
      ? createSignalCache({
          now,
          fetchJson: (ql) =>
            proxyClient.getJson('overpass', '/interpreter', { params: { data: ql } }),
        })
      : null;

  function set(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const fn of [...listeners]) {
      try {
        fn(state);
      } catch (err) {
        console.error('[argus] nav listener failed', err);
      }
    }
  }

  async function computeRoutes(from, dest, o) {
    if (!proxyClient)
      throw Object.assign(new Error('routing needs the proxy'), { code: 'no-proxy' });
    const chain = providerChain({ ...o, tomtom: available('tomtom-routing') });
    let lastErr = null;
    for (const id of chain) {
      const p = PROVIDERS[id];
      const req = p.request(from, dest, o); // a bad stop list throws: no router would take it
      let json;
      try {
        json = await proxyClient.getJson(req.feed, req.path, { params: req.params });
      } catch (err) {
        if (id === 'tomtom') learn('tomtom-routing', err);
        note('warn', `${id.toUpperCase()} ROUTING FAILED`, err?.message);
        lastErr = err;
        continue;
      }
      const routes = p.parse(json, o);
      if (routes.length) {
        if (id === 'tomtom') learnt['tomtom-routing'] = true;
        for (const r of routes) r.id = `r${(routeSeq += 1)}`;
        return routes;
      }
      const why = id === 'osrm' ? routeErrorMessage(json) : valhalla.errorMessage(json);
      lastErr = Object.assign(new Error(why), { code: 'no-route' });
    }
    throw lastErr ?? Object.assign(new Error('no route found'), { code: 'no-route' });
  }

  /**
   * Count signals on each route; resolve within `signalTimeoutMs` whatever
   * Overpass does (a late count still lands on the route objects, and the
   * state is re-sent when it does).
   */
  function countSignals(routes, onLate) {
    if (!signalCache) return Promise.resolve(false);
    const work = Promise.all(
      routes.map((r) =>
        annotateSignals(r, signalCache).catch((err) => {
          note('warn', 'SIGNAL COUNT FAILED', err?.message);
        }),
      ),
    );
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('late'), signalTimeoutMs);
    });
    return Promise.race([work.then(() => 'done'), timeout]).then((how) => {
      clearTimeout(timer);
      if (how === 'late') work.then(onLate);
      return how === 'done';
    });
  }

  function options(raw = {}) {
    return {
      mode: navMode(raw.mode ?? 'drive') ?? 'drive',
      avoidHighways: Boolean(raw.avoidHighways),
      traffic: raw.traffic !== false,
      heading: Number.isFinite(raw.heading) ? raw.heading : null,
    };
  }

  function reroute(fix) {
    if (rerouting || now() - rerouteAt < REROUTE_GAP_MS || !state.destination) return;
    rerouting = true;
    rerouteAt = now();
    const seq = navSeq;
    const moving = Number(fix.speed) > 2 && Number.isFinite(fix.heading);
    set({ status: 'rerouting' });
    computeRoutes({ lat: fix.lat, lon: fix.lon }, state.destination, {
      ...lastOpts,
      heading: moving ? fix.heading : null,
    })
      .then(async (routes) => {
        if (seq !== navSeq) return;
        const best = routes[0];
        await countSignals([best], () => seq === navSeq && set({}));
        if (seq !== navSeq) return;
        engine = createProgress(best, { now });
        const r = lastFix ? engine.update(lastFix) : { progress: engine.initial() };
        set({ status: 'navigating', route: best, routes: [best], progress: r.progress });
      })
      .catch((err) => {
        note('warn', 'REROUTE FAILED', err?.message);
        if (seq === navSeq && state.status === 'rerouting') set({ status: 'navigating' });
      })
      .finally(() => {
        rerouting = false;
      });
  }

  return {
    /**
     * Places for a query, biased near `near` (the user, else the view centre).
     * @returns {Promise<Array<{ id, name, detail, lat, lon, kind }>>}
     */
    async search(query, { near = null, limit = 8, signal } = {}) {
      const client = proxyClient && {
        getJson: (feed, path, opts) =>
          proxyClient.getJson(feed, path, opts).then(
            (j) => {
              if (feed === TOMTOM_SEARCH_FEED) learnt[TOMTOM_SEARCH_FEED] = true;
              return j;
            },
            (err) => {
              if (feed === TOMTOM_SEARCH_FEED) learn(TOMTOM_SEARCH_FEED, err);
              throw err;
            },
          ),
      };
      return searchDestinations(client, query, {
        near,
        limit,
        tomtom: available(TOMTOM_SEARCH_FEED),
        signal,
      });
    },

    /**
     * Routes from `from` to `to`, best first (travel time plus signal wait).
     * Sets the state to planning, then previewing (or idle with `error`).
     */
    async plan(from, to, raw = {}) {
      const o = options(raw);
      const dest = toPlace(to);
      const seq = (planSeq += 1);
      navSeq += 1;
      engine = null;
      set({
        status: 'planning',
        destination: dest ?? undefined,
        routes: undefined,
        route: undefined,
        progress: undefined,
        error: undefined,
      });
      try {
        if (!dest)
          throw Object.assign(new Error('no destination'), { code: 'bad-stops' });
        const start = toPlace(from);
        if (!start)
          throw Object.assign(new Error('no start position'), { code: 'bad-stops' });
        const routes = await computeRoutes(start, dest, o);
        if (seq !== planSeq) return routes;
        const counted = await countSignals(routes, () => seq === planSeq && set({}));
        if (seq !== planSeq) return routes;
        if (counted) routes.sort((a, b) => routeCost(a) - routeCost(b));
        lastOpts = o;
        set({ status: 'previewing', routes, route: routes[0] });
        return routes;
      } catch (err) {
        if (seq === planSeq) set({ status: 'idle', error: planErrorMessage(err) });
        throw err;
      }
    },

    /** Start turn-by-turn on a route (one of state.routes, or the previewed one). */
    start(route) {
      const r = route ?? state.route ?? state.routes?.[0];
      if (!r) throw new Error('no route to start');
      navSeq += 1;
      planSeq += 1;
      lastOpts ??= options({ mode: r.mode, avoidHighways: r.avoidHighways });
      engine = createProgress(r, { now });
      const fresh =
        lastFix && (!Number.isFinite(lastFix.t) || now() - lastFix.t < FIX_FRESH_MS);
      const progress = fresh ? engine.update(lastFix).progress : engine.initial();
      set({
        status: 'navigating',
        route: r,
        routes: state.routes ?? [r],
        progress,
        error: undefined,
      });
    },

    /** End navigation or the preview: back to idle. */
    stop() {
      navSeq += 1;
      planSeq += 1;
      engine = null;
      rerouting = false;
      set({
        status: 'idle',
        destination: undefined,
        routes: undefined,
        route: undefined,
        progress: undefined,
        error: undefined,
      });
    },

    /** One GPS fix: { lat, lon, heading?, speed?, accuracy?, t }. */
    update(fix) {
      const lat = Number(fix?.lat);
      const lon = Number(fix?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      lastFix = { ...fix, lat, lon };
      if (!engine || (state.status !== 'navigating' && state.status !== 'rerouting'))
        return;
      const r = engine.update(lastFix);
      if (r.arrived) {
        set({
          status: 'arrived',
          progress: {
            ...r.progress,
            distanceRemainingM: 0,
            durationRemainingS: 0,
            eta: now(),
          },
        });
        engine = null;
        return;
      }
      set({ progress: r.progress });
      if (r.offRoute) reroute(lastFix);
    },

    get state() {
      return state;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // --- beyond the contract: what the panels use ---------------------------
    /** Highlight one of the previewed routes (a route or its id). */
    select(which) {
      if (state.status !== 'previewing') return;
      const r = state.routes?.find((x) => x === which || x.id === which);
      if (r && r !== state.route) set({ route: r });
    },
    /** Whether live traffic (TomTom) can be asked for. */
    get traffic() {
      return Boolean(proxyClient) && available('tomtom-routing');
    },
    /** A name for a dropped pin (Nominatim reverse), or null. */
    reverse: (lat, lon, opts) => reverseName(proxyClient, lat, lon, opts),
    /** The last fix given to update(). */
    get lastFix() {
      return lastFix;
    },
  };
}
