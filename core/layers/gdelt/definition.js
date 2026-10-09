import { ink } from '../sdk/colors.js';
import { parseGdeltEvents, gdeltStatusNote } from './parse.js';
import {
  describeGdelt,
  gdeltInkName,
  gdeltPixelSize,
  gdeltSearchText,
} from './format.js';

// GDELT events (the master plan's "News / events", Disaster preset) as a Layer
// SDK point layer: where news reported protests, violence and humanitarian aid
// in the last hour (GDELT 2.0 Events, built by the proxy from GDELT's
// 15-minute exports), one glyph per event type and place, sized by mentions,
// with the article links on the card. No query is ever sent
// (core/layers/gdelt/parse.js). Global, refreshed every 15 minutes.

export const gdeltDefinition = {
  id: 'gdelt',
  fetch: { mode: 'poll', intervalMs: 15 * 60_000, viewportBounded: false },
  interpolate: false,
  maxEntities: 3000,
  normalize: (raw) => parseGdeltEvents(raw),
  statusNote: (_q, raw) => gdeltStatusNote(raw),
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
