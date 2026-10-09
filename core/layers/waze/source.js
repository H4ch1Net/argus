// The Waze source: the view's box through the proxy, from your own waze-server
// when LOCAL_WAZE_URL is set (the 'waze-local' feed), else from the live map's
// endpoint (the 'waze' feed). Returns { json, clipped, via, note? } for the
// definition. A 403 from the live map holds the layer off it for 30 minutes
// (or until RELOAD) with one log entry, not an error every poll. Pure: no
// Cesium; the terminal uses it too.

import {
  WAZE_FEED,
  WAZE_PATH,
  WAZE_LOCAL_FEED,
  WAZE_LOCAL_PATH,
  wazeBox,
  wazeQuery,
  wazeLocalQuery,
} from './parse.js';

/** How long a refusal (403) from Waze's live map stops the layer asking. */
export const WAZE_REFUSED_MS = 30 * 60_000;
export const WAZE_REFUSED_NOTE =
  'Waze refused (403); set LOCAL_WAZE_URL to your own waze-server';

/**
 * Waze's live map answers 403 to Argus (it never poses as a browser): once
 * refused, ask again only after `holdMs`, or on RELOAD (query.reload).
 * Pure over an injected clock.
 */
export function createRefusalGate({
  holdMs = WAZE_REFUSED_MS,
  now = () => Date.now(),
} = {}) {
  let until = 0;
  return {
    /** Refused now: returns true the first time (log it), false while it holds. */
    refuse() {
      const first = now() >= until;
      until = now() + holdMs;
      return first;
    },
    held: () => now() < until,
    clear() {
      until = 0;
    },
    get until() {
      return until;
    },
  };
}

/**
 * @param {{ proxyClient: object, local?: boolean, log?: Function|null,
 *   gate?: ReturnType<typeof createRefusalGate> }} opts
 *   local: the proxy has LOCAL_WAZE_URL (read from /health by the caller)
 *   log: one LOGS entry when Waze refuses (core/ui/logs.js entry shape)
 */
export function createWazeSource({
  proxyClient,
  local = false,
  log = null,
  gate = createRefusalGate(),
}) {
  // A refusal shows as a quiet, empty answer with the reason, not an error
  // every poll (the layer's status note carries it).
  const refused = (clipped) => ({
    json: { alerts: [], jams: [] },
    clipped,
    via: 'refused',
    note: WAZE_REFUSED_NOTE,
  });
  return async (query, signal) => {
    const box = wazeBox(query?.bbox);
    if (!box) return { json: { alerts: [], jams: [] }, clipped: false, via: null };
    if (local) {
      const json = await proxyClient.getJson(WAZE_LOCAL_FEED, WAZE_LOCAL_PATH, {
        params: wazeLocalQuery(query.bbox),
        signal,
      });
      return { json, clipped: box.clipped, via: 'local' };
    }
    if (query?.reload) gate.clear();
    if (gate.held()) return refused(box.clipped);
    let json;
    try {
      json = await proxyClient.getJson(WAZE_FEED, WAZE_PATH, {
        params: wazeQuery(query.bbox),
        signal,
      });
    } catch (err) {
      if (err?.status !== 403) throw err;
      if (gate.refuse())
        log?.({
          level: 'warn',
          source: 'waze',
          title: 'WAZE REFUSED',
          body: `Waze's live map answered 403 to Argus; not asking again for ${Math.round(WAZE_REFUSED_MS / 60_000)} min (or until RELOAD). Set LOCAL_WAZE_URL to your own waze-server.`,
        });
      return refused(box.clipped);
    }
    return { json, clipped: box.clipped, via: 'live' };
  };
}

const rand = (a, b) => a + Math.random() * (b - a);
const DEMO_ALERTS = [
  ['ACCIDENT', 'ACCIDENT_MAJOR'],
  ['ACCIDENT', 'ACCIDENT_MINOR'],
  ['HAZARD', 'HAZARD_ON_ROAD_POT_HOLE'],
  ['HAZARD', 'HAZARD_ON_SHOULDER_CAR_STOPPED'],
  ['ROAD_CLOSED', 'ROAD_CLOSED_CONSTRUCTION'],
  ['JAM', 'JAM_HEAVY_TRAFFIC'],
  ['WEATHERHAZARD', 'HAZARD_WEATHER_FOG'],
  ['CONSTRUCTION', ''],
  ['POLICE', 'POLICE_VISIBLE'],
];

/** Dev / demo stand-in: Waze-shaped alerts and jams over the requested view. */
export function createWazeMockSource() {
  return async (query) => {
    const b = wazeBox(query?.bbox) ?? {
      lomin: -122.46,
      lamin: 37.74,
      lomax: -122.38,
      lamax: 37.8,
      clipped: false,
    };
    const now = Date.now();
    const alerts = DEMO_ALERTS.map(([type, subtype], i) => ({
      uuid: `demo-${i}`,
      type,
      subtype,
      location: { x: rand(b.lomin, b.lomax), y: rand(b.lamin, b.lamax) },
      street: `Demo Street ${i + 1}`,
      city: 'Demo City',
      reliability: 5 + (i % 5),
      nThumbsUp: i % 3,
      pubMillis: now - (i + 1) * 4 * 60_000,
    }));
    const jams = [3, 5].map((level, i) => {
      const lon = rand(b.lomin, b.lomax);
      const lat = rand(b.lamin, b.lamax);
      return {
        uuid: `demo-jam-${i}`,
        level,
        speedKMH: level === 5 ? 3 : 18,
        delay: level === 5 ? 420 : 150,
        length: 900,
        street: `Demo Avenue ${i + 1}`,
        city: 'Demo City',
        line: Array.from({ length: 8 }, (_, k) => ({
          x: lon + k * 0.0015,
          y: lat + Math.sin(k / 2) * 0.0006,
        })),
        pubMillis: now - 6 * 60_000,
      };
    });
    return { json: { alerts, jams }, clipped: b.clipped, via: 'demo' };
  };
}
