// Dev / demo-only dams: Overpass-shaped elements scattered in the current
// view, so the dams layer works offline.

import { computeViewportQuery } from '../sdk/viewport.js';

export function createDamMockSource({ viewer }) {
  return async (query) => {
    const bbox = query?.bbox ?? computeViewportQuery(viewer).bbox;
    if (bbox.lamax - bbox.lamin > 10) return { elements: [] };
    const r = (a, b) => a + Math.random() * (b - a);
    const elements = Array.from({ length: 5 }, (_, i) => ({
      type: i % 2 ? 'way' : 'node',
      id: 9_500_000 + i,
      ...(i % 2
        ? { center: { lat: r(bbox.lamin, bbox.lamax), lon: r(bbox.lomin, bbox.lomax) } }
        : { lat: r(bbox.lamin, bbox.lamax), lon: r(bbox.lomin, bbox.lomax) }),
      tags: {
        waterway: 'dam',
        name: `Demo Dam ${i + 1} (simulated)`,
        operator: 'Demo Water Authority',
        height: String(20 + i * 15),
        start_date: String(1930 + i * 12),
      },
    }));
    return { elements };
  };
}
