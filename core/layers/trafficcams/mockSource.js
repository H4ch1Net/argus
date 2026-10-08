// Dev / demo-only traffic cameras: a few simulated cameras in the current view
// with no image, so the layer works offline (cards say "demo (simulated)").

import { computeViewportQuery } from '../sdk/viewport.js';

export function createTrafficCamMockSource({ viewer }) {
  return async (query) => {
    const b = query?.bbox ?? computeViewportQuery(viewer).bbox;
    if (b.lamax - b.lamin > 12) return { cameras: [], tooWide: true };
    const r = (lo, hi) => lo + Math.random() * (hi - lo);
    return {
      inView: 1,
      cameras: Array.from({ length: 8 }, (_, i) => ({
        id: `demo-${i}`,
        name: `Demo camera ${i + 1} (simulated)`,
        lat: r(b.lamin, b.lamax),
        lon: r(b.lomin, b.lomax),
        provider: 'Demo DOT',
        region: 'simulated',
        license: 'demo',
        direction: ['North', 'South', 'East', 'West'][i % 4],
        demo: true,
      })),
    };
  };
}
