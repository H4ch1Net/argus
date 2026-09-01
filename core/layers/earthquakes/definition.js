import * as Cesium from 'cesium';
import { parseQuakes } from './parse.js';
import { magnitudeColorHex, magnitudePixelSize, describeQuake } from './format.js';

// Earthquakes as a Layer SDK definition: the cleanest events reference. Static
// points (no interpolation), sized and colored by magnitude, polled from USGS.
// USGS feeds refresh once a minute; we poll every 2 minutes.

export const earthquakesDefinition = {
  id: 'usgs-quakes',
  fetch: { mode: 'poll', intervalMs: 2 * 60 * 1000, viewportBounded: false },
  interpolate: false,
  maxEntities: 5000,
  normalize: (raw) => parseQuakes(raw),
  render: {
    renderType: 'point',
    style: (n) => ({
      pixelSize: magnitudePixelSize(n.meta.mag),
      color: Cesium.Color.fromCssColorString(magnitudeColorHex(n.meta.mag)).withAlpha(
        0.85,
      ),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.4),
    }),
  },
  describe: (n) => describeQuake(n),
  searchText: (n) => `${n.meta.place || ''} M${n.meta.mag ?? ''}`,
};
