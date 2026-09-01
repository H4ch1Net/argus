import * as Cesium from 'cesium';
import { parseFires } from './parse.js';
import { fireColorHex, firePixelSize, describeFire } from './format.js';

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
    renderType: 'point',
    style: (n) => ({
      pixelSize: firePixelSize(n.meta.frp),
      color: Cesium.Color.fromCssColorString(fireColorHex(n.meta.frp)).withAlpha(0.9),
      outlineColor: Cesium.Color.fromCssColorString('#3a0d00').withAlpha(0.6),
    }),
  },
  describe: (n) => describeFire(n),
};
