import { parseFires } from './parse.js';
import { firePixelSize, describeFire } from './format.js';
import { ink } from '../sdk/colors.js';

// Fires (NASA FIRMS) as a Layer SDK definition. Viewport-bounded (global VIIRS
// queries are huge and credit-limited), polled every few minutes, rendered as
// points colored and sized by radiative power. The source returns CSV; normalize
// parses it.

export const firesDefinition = {
  id: 'firms',
  fetch: { mode: 'poll', intervalMs: 5 * 60 * 1000, viewportBounded: true },
  interpolate: false,
  maxEntities: 6000,
  normalize: (csv) => parseFires(csv),
  render: {
    // Active fire hotspots: a hazard, so the error red, sized by radiative power.
    renderType: 'point',
    style: (n) => ({
      glyph: 'triangle',
      pixelSize: Math.round(firePixelSize(n.meta.frp) * 1.25) + 3,
      color: ink('error', 0.95),
    }),
  },
  describe: (n) => describeFire(n),
};
