// Military aircraft: adsb.lol's global list of aircraft flagged military
// (/v2/mil, the readsb database flag), parsed with the same adsb.lol reader as
// the flights layer so cards, interpolation and search behave identically. The
// one addition is the operating service (ownOp), shown only here: for military
// aircraft it names an air force or agency, never a private owner. Pure.

import { parseAdsb } from '../flights/parse.js';
import { aircraftToNormalized } from '../flights/format.js';

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 80) : null);

// The operator is shown only when it reads as a state body (an air force, a
// navy, a ministry, a coast guard...). A civil aircraft wrongly flagged as
// military would otherwise show its registered owner, who may be a person.
const STATE_OPERATOR =
  /\b(air ?force|navy|naval|army|marines?|coast ?guard|guard|military|defen[cs]e|ministry|government|federal|national|state|police|border|customs|nato|royal|armed|forces|luftwaffe|marine|aviation corps|aeronautica|arm[ée]e|fuerza|corps|air arm|usaf|usn|usmc|usag|raf|raaf|rcaf|rnzaf|iaf|jasdf|jmsdf|rokaf|tni|bundeswehr)\b/i;
const stateOperator = (v) => {
  const t = text(v);
  return t && STATE_OPERATOR.test(t) ? t : null;
};

/**
 * @param {{ ac?: object[], now?: number }} payload
 * @returns {object[]} normalized entities (type 'military')
 */
export function parseMilitary(payload) {
  const operators = new Map();
  // The address as adsb.lol spells it ('~' marks a non-ICAO address), which is
  // what its trace files are named by (trace.js tracePath).
  const hexes = new Map();
  for (const a of Array.isArray(payload?.ac) ? payload.ac : []) {
    if (a && typeof a.hex === 'string') {
      const id = a.hex.replace(/^~/, '').toLowerCase();
      operators.set(id, stateOperator(a.ownOp));
      hexes.set(id, a.hex.trim().toLowerCase());
    }
  }
  const source = payload?.demo ? 'demo (simulated)' : 'adsb.lol (military)';
  return parseAdsb(payload).aircraft.map((a) => ({
    ...aircraftToNormalized({
      ...a,
      operator: operators.get(a.id) ?? null,
      hex: hexes.get(a.id) ?? a.id,
      source,
    }),
    type: 'military',
  }));
}

export const militarySearchText = (n) =>
  [n.meta.callsign, n.id, n.meta.registration, n.meta.typeCode, n.meta.operator]
    .filter(Boolean)
    .join(' ');
