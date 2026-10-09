// The Waze source: the view's box through the proxy, from your own waze-server
// when LOCAL_WAZE_URL is set (the 'waze-local' feed), else from the live map's
// endpoint (the 'waze' feed). Returns { json, clipped, via } for the
// definition. Pure: no Cesium; the terminal uses it too.

import {
  WAZE_FEED,
  WAZE_PATH,
  WAZE_LOCAL_FEED,
  WAZE_LOCAL_PATH,
  wazeBox,
  wazeQuery,
  wazeLocalQuery,
} from './parse.js';

/**
 * @param {{ proxyClient: object, local?: boolean }} opts
 *   local: the proxy has LOCAL_WAZE_URL (read from /health by the caller)
 */
export function createWazeSource({ proxyClient, local = false }) {
  return async (query, signal) => {
    const box = wazeBox(query?.bbox);
    if (!box) return { json: { alerts: [], jams: [] }, clipped: false, via: null };
    const json = local
      ? await proxyClient.getJson(WAZE_LOCAL_FEED, WAZE_LOCAL_PATH, {
          params: wazeLocalQuery(query.bbox),
          signal,
        })
      : await proxyClient.getJson(WAZE_FEED, WAZE_PATH, {
          params: wazeQuery(query.bbox),
          signal,
        });
    return { json, clipped: box.clipped, via: local ? 'local' : 'live' };
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
