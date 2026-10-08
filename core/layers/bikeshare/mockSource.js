// Dev / demo-only bikeshare: simulated stations in the current view, with
// availability that drifts, so the layer works offline.

import { computeViewportQuery } from '../sdk/viewport.js';

export function createBikeshareMockSource({ viewer }) {
  const system = { id: 'demo', city: 'simulated', provider: 'Demo Bikes' };
  let stations = null;
  return async (query) => {
    const b = query?.bbox ?? computeViewportQuery(viewer).bbox;
    if (b.lamax - b.lamin > 3) return { stations: [], tooWide: true };
    const r = (lo, hi) => lo + Math.random() * (hi - lo);
    stations ??= Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      name: `Demo station ${i + 1}`,
      lat: r(b.lamin, b.lamax),
      lon: r(b.lomin, b.lomax),
      capacity: 20,
      bikes: Math.floor(r(0, 20)),
    }));
    for (const s of stations)
      s.bikes = Math.max(0, Math.min(20, s.bikes + Math.round(r(-2, 2))));
    return {
      inView: 1,
      stations: stations.map((s) => ({
        ...s,
        docks: 20 - s.bikes,
        renting: true,
        returning: true,
        lastReported: Math.floor(Date.now() / 1000),
        demo: true,
        system,
      })),
    };
  };
}
