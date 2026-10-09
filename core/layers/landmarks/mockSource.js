// Dev-only mock landmarks source: Overpass-shaped nodes within the current view.
// Dev-gated + dynamic-imported.

import { computeViewportQuery } from '../sdk/viewport.js';

const rand = (a, b) => a + Math.random() * (b - a);
const KINDS = [
  { tourism: 'attraction', name: 'Overlook' },
  { tourism: 'museum', name: 'City Museum' },
  { historic: 'monument', name: 'Old Monument' },
  { tourism: 'viewpoint', name: 'Scenic Viewpoint' },
  { historic: 'castle', name: 'Hillside Castle' },
];

// Per-tile ids, so the SDK's tile cache keeps each tile's nodes apart.
const tileSeed = (key = '') =>
  [...String(key)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 100_000;

export function createLandmarkMockSource({ viewer, count = 40 }) {
  return async (query) => {
    const b = query?.bbox ?? computeViewportQuery(viewer).bbox;
    const seed = tileSeed(query?.tile);
    const elements = Array.from({ length: count }, (_, i) => {
      const k = KINDS[i % KINDS.length];
      return {
        type: 'node',
        id: 2_000_000_000 + seed * 1000 + i,
        lat: rand(b.lamin, b.lamax),
        lon: rand(b.lomin, b.lomax),
        tags: { ...k, name: `${k.name} ${i}` },
      };
    });
    return { elements };
  };
}
