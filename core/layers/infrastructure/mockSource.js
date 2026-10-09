// Dev / demo-only infrastructure: Overpass-shaped elements scattered in the
// current view, so the data-centre and installation layers work offline.

import { computeViewportQuery } from '../sdk/viewport.js';

// Per-tile ids, so the SDK's tile cache keeps each tile's elements apart.
const tileSeed = (key = '') =>
  [...String(key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 100_000;

function scatter(bbox, count, tagsFor, tile) {
  const r = (a, b) => a + Math.random() * (b - a);
  const seed = tileSeed(tile);
  return Array.from({ length: count }, (_, i) => ({
    type: 'node',
    id: 9_000_000_000 + seed * 1000 + i,
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
        ? scatter(
            bbox,
            6,
            (i) => ({
              telecom: 'data_center',
              name: `Demo DC ${i + 1} (simulated)`,
              operator: 'Demo Hosting',
            }),
            query?.tile,
          )
        : scatter(
            bbox,
            4,
            (i) => ({
              military: ['airfield', 'naval_base', 'barracks', 'range'][i % 4],
              name: `Demo installation ${i + 1} (simulated)`,
            }),
            query?.tile,
          );
    return { elements };
  };
}
