// The air-quality source: the grid for the view, fetched through the proxy's
// pinned 'openmeteo-aq' feed. Returns { grid, payload } for the definition.
// Pure: no Cesium.

import { aqGrid, aqQuery, AQ_PATH } from './field.js';

export function createAirQualitySource({ proxyClient }) {
  return async (query, signal) => {
    if (!query?.bbox) return null;
    const grid = aqGrid(query.bbox);
    const payload = await proxyClient.getJson('openmeteo-aq', AQ_PATH, {
      params: aqQuery(grid),
      signal,
    });
    return { grid, payload };
  };
}

/** Dev stand-in: a plausible AQI field (cleaner at sea, a few hot spots). */
export function createAirQualityMockSource() {
  return async (query) => {
    if (!query?.bbox) return null;
    const grid = aqGrid(query.bbox);
    const payload = grid.lats.map((lat, k) => {
      const lon = grid.lons[k];
      const us = Math.max(
        5,
        Math.round(40 + 70 * Math.sin(lat / 7) * Math.cos(lon / 11) + 30 * Math.sin(k)),
      );
      return {
        current: {
          time: '2026-10-08T09:00',
          us_aqi: us,
          european_aqi: Math.round(us * 0.6),
          pm2_5: Math.round(us / 4),
          pm10: Math.round(us / 3),
          ozone: 60,
          nitrogen_dioxide: 12,
        },
      };
    });
    return { grid, payload };
  };
}
