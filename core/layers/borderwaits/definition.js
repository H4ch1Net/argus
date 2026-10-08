import {
  parseBorderWaits,
  borderWaitNote,
  describeBorderWait,
  borderWaitSearchText,
} from './format.js';
import { ink, layerInk } from '../sdk/colors.js';

// Land border wait times (CBP into the US, CBSA into Canada) at the crossings
// the bundled ports table places, as a point layer. The wait lists are
// national and small; the view only decides whether the nearest traffic
// cameras are linked on each card. Refreshed every 5 minutes (CBP updates
// about hourly), cached by the proxy.

export const borderWaitsDefinition = {
  id: 'borderwaits',
  fetch: { mode: 'poll', intervalMs: 5 * 60 * 1000, viewportBounded: true },
  interpolate: false,
  maxEntities: 200,
  normalize: (raw) => parseBorderWaits(raw),
  statusNote: (_q, raw) => borderWaitNote(raw),
  render: {
    renderType: 'point',
    // Bigger as the passenger wait into the US grows; dim when closed.
    style: (n) => ({
      glyph: 'gate',
      pixelSize: 11 + Math.min(7, (n.meta.maxDelay ?? 0) / 20),
      color: n.meta.closed ? ink('muted') : layerInk('borderwaits'),
    }),
  },
  describe: (n) => describeBorderWait(n),
  searchText: borderWaitSearchText,
};
