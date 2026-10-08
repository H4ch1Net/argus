import { parseCyclones } from './parse.js';
import { describeCyclone, cyclonePixelSize, cycloneSearchText } from './format.js';
import { ink } from '../sdk/colors.js';

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
    // A diamond sized by wind; red from category 3, where severity is the state.
    renderType: 'point',
    style: (n) => ({
      glyph: 'diamond',
      pixelSize: Math.round(cyclonePixelSize(n.meta.windKt) * 1.2) + 4,
      color: (n.meta.windKt ?? 0) >= 96 ? ink('error') : ink('white'),
    }),
  },
  describe: (n) => describeCyclone(n),
  searchText: cycloneSearchText,
};
