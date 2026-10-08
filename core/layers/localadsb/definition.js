import { aircraftStyle } from '../flights/definition.js';
import { formatAircraft, aircraftSearchText } from '../flights/format.js';
import { parseLocalAdsb } from './parse.js';

// Aircraft heard by your own receiver (dump1090 / readsb on this machine or the
// LAN, set with LOCAL_ADSB_URL). Polled every 2 s, so motion is near real time.

export const localAdsbDefinition = {
  id: 'local-adsb',
  fetch: { mode: 'poll', intervalMs: 2000, viewportBounded: false },
  interpolate: true,
  maxEntities: 1000,
  normalize: (raw) => parseLocalAdsb(raw),
  render: {
    renderType: 'billboard',
    style: (n) => aircraftStyle(n, 'pale'),
  },
  describe: (n) => formatAircraft(n.meta),
  searchText: aircraftSearchText,
};
