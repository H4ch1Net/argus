// Dev / demo-only infrastructure: Overpass-shaped elements scattered in the
// current view, so the data-centre and installation layers work offline.

import { computeViewportQuery } from '../sdk/viewport.js';

function scatter(bbox, count, tagsFor) {
  const r = (a, b) => a + Math.random() * (b - a);
  return Array.from({ length: count }, (_, i) => ({
    type: 'node',
    id: 9_000_000 + i,
    lat: r(bbox.lamin, bbox.lamax),
    lon: r(bbox.lomin, bbox.lomax),
    tags: tagsFor(i),
  }));
}

export function createInfraMockSource({ viewer, kind }) {
  return async (query) => {
    const bbox = query?.bbox ?? computeViewportQuery(viewer).bbox;
    if (bbox.lamax - bbox.lamin > 10) return { elements: [] };
    const elements =
      kind === 'datacenters'
        ? scatter(bbox, 6, (i) => ({
            telecom: 'data_center',
            name: `Demo DC ${i + 1} (simulated)`,
            operator: 'Demo Hosting',
          }))
        : scatter(bbox, 4, (i) => ({
            military: ['airfield', 'naval_base', 'barracks', 'range'][i % 4],
            name: `Demo installation ${i + 1} (simulated)`,
          }));
    return { elements };
  };
}
