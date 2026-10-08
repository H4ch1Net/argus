import { aircraftStyle } from '../flights/definition.js';
import { formatAircraft } from '../flights/format.js';
import { parseMilitary, militarySearchText } from './parse.js';

// Military aircraft as a Layer SDK definition: adsb.lol's global military list,
// polled like flights and drawn with the same sprite in a distinct colour so the
// two layers read apart when both are on. Public ADS-B only; nothing here is
// derived beyond what the aircraft broadcast.

export const militaryDefinition = {
  id: 'military-flights',
  // A global list (a few hundred aircraft), so not viewport-bounded.
  fetch: { mode: 'poll', intervalMs: 15_000, viewportBounded: false },
  interpolate: true,
  maxEntities: 1500,
  normalize: (raw) => parseMilitary(raw),
  render: {
    renderType: 'billboard',
    style: (n) => aircraftStyle(n, 'mint'),
  },
  describe: (n) => formatAircraft(n.meta),
  searchText: militarySearchText,
};
