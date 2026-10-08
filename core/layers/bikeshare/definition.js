import * as Cesium from 'cesium';
import {
  parseBikeshare,
  bikeshareNote,
  describeBikeStation,
  bikeshareSearchText,
} from './format.js';
import { ink } from '../sdk/colors.js';

// Bikeshare stations (GBFS) as a viewport-bounded point layer, coloured by
// bikes available. Status polls every minute; station locations are cached.

export const bikeshareDefinition = {
  id: 'bikeshare',
  fetch: { mode: 'poll', intervalMs: 60_000, viewportBounded: true },
  interpolate: false,
  maxEntities: 6000,
  normalize: (raw) => parseBikeshare(raw),
  statusNote: (_q, raw) => bikeshareNote(raw),
  render: {
    // Docks: small squares, brighter when bikes are available.
    renderType: 'point',
    style: (n) => ({
      glyph: 'square',
      pixelSize: 9,
      color: (n.meta.bikes ?? 0) > 0 ? ink('gray', 0.9) : ink('muted', 0.8),
    }),
    scaleByDistance: new Cesium.NearFarScalar(2e3, 1.2, 1e6, 0.4),
  },
  describe: (n) => describeBikeStation(n),
  searchText: bikeshareSearchText,
};
