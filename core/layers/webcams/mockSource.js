// Dev / demo-only webcams: one simulated webcam per category in the current
// view, with no image, so the layer and its filter work offline (cards say
// "demo (simulated)").

import { computeViewportQuery } from '../sdk/viewport.js';
import { WEBCAM_CATEGORIES } from './categories.js';

export function createWebcamMockSource({ viewer }) {
  return async (query) => {
    const b = query?.bbox ?? computeViewportQuery(viewer).bbox;
    const r = (lo, hi) => lo + Math.random() * (hi - lo);
    return {
      offered: ['demo'],
      tooWide: false,
      failed: 0,
      webcams: WEBCAM_CATEGORIES.map((cat, i) => ({
        id: `demo-${cat.id}`,
        source: 'demo',
        name: `Demo ${cat.label.toLowerCase()} webcam (simulated)`,
        lat: r(b.lamin, b.lamax),
        lon: r(b.lomin, b.lomax),
        category: cat.id,
        tags: [cat.id],
        place: 'simulated',
        provider: 'Demo network',
        image: null,
        imageUrl: null,
        imageKind: 'live',
        pageUrl: null,
        extraLinks: [],
        rank: i,
        license: 'demo',
        demo: true,
      })),
    };
  };
}
