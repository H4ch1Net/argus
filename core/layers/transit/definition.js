import * as Cesium from 'cesium';
import { parseTransit, transitNote } from './parse.js';
import { describeTransit, transitSearchText } from './format.js';
import { ink } from '../sdk/colors.js';

// Live transit vehicles (GTFS-RT) as a Layer SDK definition: viewport-bounded
// polling of whichever covered agencies are in view, interpolated between the
// 15 s fixes like flights. Colour follows the route so a line reads as a line.

export const transitDefinition = {
  id: 'transit',
  fetch: { mode: 'poll', intervalMs: 15_000, viewportBounded: true },
  interpolate: true,
  maxEntities: 6000,
  normalize: (raw) => parseTransit(raw),
  statusNote: (_q, raw) => transitNote(raw),
  render: {
    renderType: 'point',
    style: (n) => ({
      glyph: 'vehicle',
      pixelSize: 13,
      headingDeg: Number.isFinite(n.meta.bearing) ? n.meta.bearing : undefined,
      color: ink('teal'),
    }),
    scaleByDistance: new Cesium.NearFarScalar(5e3, 1.2, 2e6, 0.5),
  },
  describe: (n) => describeTransit(n),
  searchText: transitSearchText,
};
