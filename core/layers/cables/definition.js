import { parseCables } from './parse.js';
import { describeCable, cableSearchText } from './format.js';
import { ink } from '../sdk/colors.js';

// Submarine cables as polylines (TeleGeography's public map data, fetched once
// a day through the proxy). Drawn slightly above sea level rather than clamped
// to the ground, which keeps ~2,000 long segments cheap on a phone. Each cable
// keeps the colour TeleGeography gives it.

export const cablesDefinition = {
  id: 'cables',
  fetch: { mode: 'poll', intervalMs: 24 * 60 * 60 * 1000, viewportBounded: false },
  interpolate: false,
  maxEntities: 6000,
  normalize: (raw) => parseCables(raw),
  render: {
    renderType: 'polyline',
    height: 300,
    width: 1.5,
    // Sea cables in slate: infrastructure context, not the foreground.
    style: () => ({ color: ink('slate', 0.7) }),
  },
  describe: (n) => describeCable(n),
  searchText: cableSearchText,
};
