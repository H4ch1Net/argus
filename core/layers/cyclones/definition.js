import * as Cesium from 'cesium';
import { parseCyclones } from './parse.js';
import {
  describeCyclone,
  cycloneColorHex,
  cyclonePixelSize,
  cycloneSearchText,
} from './format.js';

// Active tropical cyclones (NOAA NHC) as a Layer SDK definition: a handful of
// static points, sized and coloured by intensity, refreshed every 5 minutes
// (NHC issues advisories every 3 to 6 hours; positions update in between).

export const cyclonesDefinition = {
  id: 'cyclones',
  fetch: { mode: 'poll', intervalMs: 5 * 60 * 1000, viewportBounded: false },
  interpolate: false,
  maxEntities: 32,
  normalize: (raw) => parseCyclones(raw),
  statusNote: (_q, raw) => (raw && !raw.activeStorms?.length ? 'no active storms' : ''),
  render: {
    renderType: 'point',
    style: (n) => ({
      pixelSize: cyclonePixelSize(n.meta.windKt),
      color: Cesium.Color.fromCssColorString(cycloneColorHex(n.meta.windKt)),
    }),
  },
  describe: (n) => describeCyclone(n),
  searchText: cycloneSearchText,
};
