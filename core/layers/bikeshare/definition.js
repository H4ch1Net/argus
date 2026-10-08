import * as Cesium from 'cesium';
import {
  parseBikeshare,
  bikeshareNote,
  describeBikeStation,
  bikeColorHex,
  bikeshareSearchText,
} from './format.js';

// Bikeshare stations (GBFS) as a viewport-bounded point layer, coloured by
// bikes available. Status polls every minute; station locations are cached.

const colors = new Map();
const color = (hex) => {
  if (!colors.has(hex)) colors.set(hex, Cesium.Color.fromCssColorString(hex));
  return colors.get(hex);
};

export const bikeshareDefinition = {
  id: 'bikeshare',
  fetch: { mode: 'poll', intervalMs: 60_000, viewportBounded: true },
  interpolate: false,
  maxEntities: 6000,
  normalize: (raw) => parseBikeshare(raw),
  statusNote: (_q, raw) => bikeshareNote(raw),
  render: {
    renderType: 'point',
    style: (n) => ({ pixelSize: 6, color: color(bikeColorHex(n.meta)) }),
    scaleByDistance: new Cesium.NearFarScalar(2e3, 1.2, 1e6, 0.4),
  },
  describe: (n) => describeBikeStation(n),
  searchText: bikeshareSearchText,
};
