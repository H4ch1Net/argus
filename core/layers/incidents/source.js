// The TomTom incident source: the view's box (clipped to the API's area limit)
// through the proxy's pinned 'tomtom-incidents' feed, which adds the key server
// side. Returns { json, clipped } for the definition. Pure: no Cesium; the
// terminal uses it too.

import { incidentBox, incidentQuery, TOMTOM_INCIDENT_PATH } from './parse.js';

export function createIncidentSource({ proxyClient }) {
  return async (query, signal) => {
    const params = incidentQuery(query?.bbox);
    if (!params) return { json: { incidents: [] }, clipped: false };
    const json = await proxyClient.getJson('tomtom-incidents', TOMTOM_INCIDENT_PATH, {
      params,
      signal,
    });
    return { json, clipped: incidentBox(query.bbox).clipped };
  };
}

const rand = (a, b) => a + Math.random() * (b - a);
const ICONS = [1, 6, 9, 8, 3, 4, 6, 7, 14, 6];

/** Dev / demo stand-in: TomTom-shaped incidents over the requested view. */
export function createIncidentMockSource() {
  return async (query) => {
    const b = incidentBox(query?.bbox) ?? {
      lomin: -0.2,
      lamin: 51.4,
      lomax: 0,
      lamax: 51.6,
    };
    const incidents = ICONS.map((icon, i) => {
      const lon = rand(b.lomin, b.lomax);
      const lat = rand(b.lamin, b.lamax);
      const line = icon === 6 || icon === 9 || icon === 8;
      return {
        type: 'Feature',
        geometry: line
          ? {
              type: 'LineString',
              coordinates: Array.from({ length: 6 }, (_, k) => [
                lon + k * 0.002,
                lat + Math.sin(k) * 0.0008,
              ]),
            }
          : { type: 'Point', coordinates: [lon, lat] },
        properties: {
          id: `demo-${i}`,
          iconCategory: icon,
          magnitudeOfDelay: [3, 2, 1, 4, 0][i % 5],
          events: [
            { description: 'Demo incident (simulated)', code: 0, iconCategory: icon },
          ],
          startTime: new Date(Date.now() - 3_600_000).toISOString(),
          endTime: null,
          from: 'Demo Street',
          to: 'Example Road',
          length: line ? 1200 : 0,
          delay: line ? 420 : 0,
          roadNumbers: ['A1'],
          demo: true,
        },
      };
    });
    return { json: { incidents }, clipped: Boolean(incidentBox(query?.bbox)?.clipped) };
  };
}
