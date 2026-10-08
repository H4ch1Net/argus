import { parseQuakes } from './parse.js';
import { magnitudePixelSize, describeQuake } from './format.js';
import { ink } from '../sdk/colors.js';

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
    // Concentric squares sized by magnitude; ctOS gray, white from M4.5, and
    // the error red only for a strong quake (M6+), where severity is the state.
    renderType: 'point',
    style: (n) => {
      const mag = n.meta.mag ?? 0;
      return {
        glyph: 'pulse',
        pixelSize: Math.round(magnitudePixelSize(mag) * 1.3) + 4,
        color: mag >= 6 ? ink('error') : mag >= 4.5 ? ink('white') : ink('gray', 0.85),
      };
    },
  },
  describe: (n) => describeQuake(n),
  searchText: (n) => `${n.meta.place || ''} M${n.meta.mag ?? ''}`,
};
