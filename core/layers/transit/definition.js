import * as Cesium from 'cesium';
import { parseTransit, transitNote } from './parse.js';
import { describeTransit, transitColorHex, transitSearchText } from './format.js';

// Live transit vehicles (GTFS-RT) as a Layer SDK definition: viewport-bounded
// polling of whichever covered agencies are in view, interpolated between the
// 15 s fixes like flights. Colour follows the route so a line reads as a line.

const colors = new Map();
const routeColor = (routeId) => {
  const hex = transitColorHex(routeId);
  if (!colors.has(hex)) colors.set(hex, Cesium.Color.fromCssColorString(hex));
  return colors.get(hex);
};

export const transitDefinition = {
  id: 'transit',
  fetch: { mode: 'poll', intervalMs: 15_000, viewportBounded: true },
  interpolate: true,
  maxEntities: 6000,
  normalize: (raw) => parseTransit(raw),
  statusNote: (_q, raw) => transitNote(raw),
  render: {
    renderType: 'point',
    style: (n) => ({ pixelSize: 6, color: routeColor(n.meta.routeId) }),
    scaleByDistance: new Cesium.NearFarScalar(5e3, 1.2, 2e6, 0.5),
  },
  describe: (n) => describeTransit(n),
  searchText: transitSearchText,
};
