// Your own ADS-B receiver: the aircraft.json that dump1090, readsb and tar1090
// serve ({ now: seconds, aircraft: [...] } in the same readsb schema adsb.lol
// uses). Parsed with the flights layer's adsb.lol reader, so cards, trails and
// interpolation are identical. Positions not heard for a minute are dropped. Pure.

import { parseAdsb } from '../flights/parse.js';
import { aircraftToNormalized } from '../flights/format.js';

const STALE_POSITION_S = 60;

/**
 * @param {{ now?: number, aircraft?: object[], demo?: boolean }} payload
 * @returns {object[]} normalized entities (type 'aircraft-local')
 */
export function parseLocalAdsb(payload) {
  const list = Array.isArray(payload?.aircraft) ? payload.aircraft : [];
  const heard = list.filter(
    (a) => a && (typeof a.seen_pos !== 'number' || a.seen_pos <= STALE_POSITION_S),
  );
  const nowMs = typeof payload?.now === 'number' ? payload.now * 1000 : undefined;
  const source = payload?.demo ? 'demo (simulated)' : 'your receiver (1090 MHz)';
  return parseAdsb({ ac: heard, now: nowMs }).aircraft.map((a) => ({
    ...aircraftToNormalized({ ...a, source }),
    type: 'aircraft-local',
  }));
}
