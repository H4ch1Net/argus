import { ink } from '../sdk/colors.js';
import { parseGdeltThemes } from './parse.js';
import { describeGdelt, gdeltInkName, gdeltPixelSize, gdeltSearchText } from './format.js';

// GDELT events (the master plan's "News / events", Disaster preset) as a Layer
// SDK point layer: places reported in the last 24 hours under a few fixed
// themes (natural disasters, protests, armed conflict), one glyph per place and
// theme, sized by the number of reports, with the headlines and links on the
// card. Fixed queries only (core/layers/gdelt/parse.js). Global, refreshed
// every 15 minutes.

export const gdeltDefinition = {
  id: 'gdelt',
  fetch: { mode: 'poll', intervalMs: 15 * 60_000, viewportBounded: false },
  interpolate: false,
  maxEntities: 3000,
  normalize: (raw) => parseGdeltThemes(raw),
  render: {
    renderType: 'point',
    style: (n) => ({
      glyph: 'news',
      pixelSize: gdeltPixelSize(n),
      color: ink(gdeltInkName(n)),
    }),
  },
  describe: (n) => describeGdelt(n),
  searchText: gdeltSearchText,
};
