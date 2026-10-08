import { windGrid, windQuery } from './field.js';

// The wind source: the grid for the view, fetched through the proxy's pinned
// 'openmeteo-wind' feed. Returns { grid, payload } for the definition.

export function createWindSource({ proxyClient }) {
  return async (query, signal) => {
    if (!query?.bbox) return null;
    const grid = windGrid(query.bbox);
    const payload = await proxyClient.getJson('openmeteo-wind', '/forecast', {
      params: windQuery(grid),
      signal,
    });
    return { grid, payload };
  };
}

/** Dev stand-in: a plausible rotating wind over the requested grid. */
export function createWindMockSource() {
  return async (query) => {
    if (!query?.bbox) return null;
    const grid = windGrid(query.bbox);
    const t = Date.now() / 600_000;
    const payload = grid.lats.map((lat, k) => {
      const lon = grid.lons[k];
      const speed = 4 + 10 * Math.abs(Math.sin((lat + t) / 15) * Math.cos(lon / 25));
      const dir =
        (270 + 60 * Math.sin(lon / 30 + t) + 40 * Math.cos(lat / 20) + 360) % 360;
      return {
        current: {
          wind_speed_10m: speed,
          wind_direction_10m: dir,
          time: '2026-10-08T09:00',
        },
      };
    });
    return { grid, payload };
  };
}
