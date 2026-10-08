// Military aircraft: adsb.lol's global list of aircraft flagged military
// (/v2/mil, the readsb database flag), parsed with the same adsb.lol reader as
// the flights layer so cards, interpolation and search behave identically. The
// one addition is the operating service (ownOp), shown only here: for military
// aircraft it names an air force or agency, never a private owner. Pure.

import { parseAdsb } from '../flights/parse.js';
import { aircraftToNormalized } from '../flights/format.js';

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);

/**
 * @param {{ ac?: object[], now?: number }} payload
 * @returns {object[]} normalized entities (type 'military')
 */
export function parseMilitary(payload) {
  const operators = new Map();
  for (const a of Array.isArray(payload?.ac) ? payload.ac : []) {
    if (a && typeof a.hex === 'string') {
      operators.set(a.hex.replace(/^~/, '').toLowerCase(), text(a.ownOp));
    }
  }
  const source = payload?.demo ? 'demo (simulated)' : 'adsb.lol (military)';
  return parseAdsb(payload).aircraft.map((a) => ({
    ...aircraftToNormalized({ ...a, operator: operators.get(a.id) ?? null, source }),
    type: 'military',
  }));
}

export const militarySearchText = (n) =>
  [n.meta.callsign, n.id, n.meta.registration, n.meta.typeCode, n.meta.operator]
    .filter(Boolean)
    .join(' ');
