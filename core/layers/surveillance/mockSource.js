// Dev-only mock surveillance source: Overpass-shaped nodes within the current
// view (a mix of ALPR readers and ordinary cameras, most with a mapped facing,
// some without) so the layer and its view cones are demonstrable without a
// proxy. Dev-gated + dynamic-imported.

import { computeViewportQuery } from '../sdk/viewport.js';

const rand = (a, b) => a + Math.random() * (b - a);
// Facings in every form the cone parser reads, plus none (a ring).
const FACINGS = ['90', 'NE', '200;20', '45-120', 'SSW', null, '310', 'E'];

// Per-tile ids, so the SDK's tile cache keeps each tile's nodes apart.
const tileSeed = (key = '') =>
  [...String(key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 100_000;

export function createSurveillanceMockSource({ viewer, count = 60 }) {
  return async (query) => {
    const b = query?.bbox ?? computeViewportQuery(viewer).bbox;
    const seed = tileSeed(query?.tile);
    const elements = Array.from({ length: count }, (_, i) => {
      const alpr = i % 4 === 0;
      return {
        type: 'node',
        id: 1_000_000_000 + seed * 1000 + i,
        lat: rand(b.lamin, b.lamax),
        lon: rand(b.lomin, b.lomax),
        tags: {
          man_made: 'surveillance',
          'surveillance:type': alpr ? 'ALPR' : 'camera',
          surveillance: alpr ? 'public' : 'outdoor',
          operator: alpr ? 'Flock Safety' : 'City DOT',
          ...(FACINGS[i % FACINGS.length]
            ? { 'camera:direction': FACINGS[i % FACINGS.length] }
            : {}),
        },
      };
    });
    return { elements };
  };
}
