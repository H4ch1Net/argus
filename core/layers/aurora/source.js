// The aurora source: the OVATION grid and the K index through the proxy's
// pinned 'swpc' feed, fetched together. A missing K index never blocks the
// oval. Returns { grid, kp } for the definition. Pure: no Cesium.

import { AURORA_PATH, KP_PATH, parseKp, parseOvation } from './parse.js';

export function createAuroraSource({ proxyClient }) {
  return async (_query, signal) => {
    const [ovation, kp] = await Promise.all([
      proxyClient.getJson('swpc', AURORA_PATH, { signal }),
      proxyClient.getJson('swpc', KP_PATH, { signal }).catch((err) => {
        if (err?.name === 'AbortError') throw err;
        return null;
      }),
    ]);
    const grid = parseOvation(ovation);
    if (!grid) throw new Error('SWPC: no aurora grid in the answer');
    return { grid, kp: parseKp(kp) };
  };
}

/** A plausible OVATION-shaped answer: an oval around each magnetic pole. */
export function demoOvation(kp = 4) {
  const coordinates = [];
  const ovalLat = 67 - kp * 1.5;
  for (let lon = 0; lon < 360; lon += 1) {
    for (let lat = -90; lat <= 90; lat += 1) {
      // The geomagnetic poles sit off the geographic ones; tilt the oval.
      const tilt = 4 * Math.cos(((lon - (lat > 0 ? 290 : 110)) * Math.PI) / 180);
      const d = Math.abs(Math.abs(lat) - (ovalLat - tilt));
      const p = Math.max(0, Math.round((kp * 12 + 10) * Math.exp(-(d * d) / 18)));
      coordinates.push([lon, lat, p]);
    }
  }
  const now = new Date().toISOString().slice(0, 19);
  return {
    'Observation Time': `${now}Z`,
    'Forecast Time': `${now}Z`,
    'Data Format': '[Longitude, Latitude, Aurora]',
    coordinates,
  };
}

export function createAuroraMockSource() {
  return async () => ({
    grid: parseOvation(demoOvation()),
    kp: { kp: 4, time: new Date().toISOString() },
  });
}
