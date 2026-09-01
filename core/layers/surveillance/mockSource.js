// Dev-only mock surveillance source: Overpass-shaped nodes within the current
// view (a mix of ALPR readers and ordinary cameras) so the layer is demonstrable
// without a proxy. Dev-gated + dynamic-imported.

import { computeViewportQuery } from '../sdk/viewport.js';

const rand = (a, b) => a + Math.random() * (b - a);

export function createSurveillanceMockSource({ viewer, count = 30 }) {
  return async () => {
    const b = computeViewportQuery(viewer).bbox;
    const elements = Array.from({ length: count }, (_, i) => {
      const alpr = i % 4 === 0;
      return {
        type: 'node',
        id: 1_000_000 + i,
        lat: rand(b.lamin, b.lamax),
        lon: rand(b.lomin, b.lomax),
        tags: {
          man_made: 'surveillance',
          'surveillance:type': alpr ? 'ALPR' : 'camera',
          surveillance: alpr ? 'public' : 'outdoor',
          operator: alpr ? 'Flock Safety' : 'City DOT',
        },
      };
    });
    return { elements };
  };
}
