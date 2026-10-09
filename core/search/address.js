// Street addresses near the user. Photon (OSM) often has the street but not
// the house number ("46211 Jackson Street" finds Jackson Street, or a Jackson
// Street in another state), so a query that starts with a house number also
// asks an address geocoder: the US Census Bureau's for a US address (the
// user's state appended when the query names none), else OSM Nominatim with a
// box around the user as a bias. The answers are ranked with the rest
// (./rank.js), nearest first among equals. Pure apart from the injected proxy
// client; inputs are addresses, never people.

import { CENSUS_FEED, CENSUS_PATH, censusParams, parseCensus } from './census.js';
import { regionNear } from './region.js';
import { distanceKm } from './rank.js';

// State and territory names and USPS codes: a query that already names one
// (or a ZIP code) is sent to the Census geocoder as typed.
export const US_STATES = Object.freeze({
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
  PR: 'Puerto Rico',
});
const STATE_NAMES = new Set(Object.values(US_STATES).map((s) => s.toLowerCase()));
const STATE_CODES = new Set(Object.keys(US_STATES).map((s) => s.toLowerCase()));

const clean = (q) =>
  String(q ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

/**
 * A query that reads as a street address: a house number first ("46211
 * Jackson St", "12B Main Street", "1600-A Elm"), then a street name with at
 * least one word of three or more letters. Returns its parts, or null.
 * `region`: the query already ends with a US state, a state code after a
 * comma, or a ZIP code.
 * @returns {{ number: string, street: string, region: boolean } | null}
 */
export function parseAddress(query) {
  const q = clean(query);
  const m = /^(\d{1,6}[a-z]?)(?:-[a-z0-9]{1,4})?,?\s+(.+)$/i.exec(q);
  if (!m || !/[a-z]{3,}/i.test(m[2])) return null;
  return { number: m[1].toLowerCase(), street: m[2], region: namesRegion(q) };
}

function namesRegion(q) {
  const lower = q.toLowerCase();
  if (/\b\d{5}(?:-\d{4})?$/.test(lower)) return true;
  const parts = lower.split(',').map((s) => s.trim());
  const tail = parts[parts.length - 1];
  if (parts.length > 1 && (STATE_CODES.has(tail) || STATE_NAMES.has(tail))) return true;
  for (const name of STATE_NAMES) if (lower.endsWith(` ${name}`)) return true;
  return false;
}

/**
 * The one-line address to send to the Census geocoder, or null when it does
 * not apply: not a numbered address, or neither the query nor the user's
 * region is in the US. The user's state is appended when the query names no
 * state or ZIP (the Census geocoder finds nothing for a bare street address);
 * with `city`, the city too (for a street name common across the state).
 * @param {string} query
 * @param {{ state?: string|null, countryCode?: string|null, city?: string|null }|null} region
 */
export function censusAddress(query, region = null, { city = false } = {}) {
  const a = parseAddress(query);
  if (!a) return null;
  const q = clean(query);
  if (a.region) return q;
  const state = region?.state;
  if (String(region?.countryCode ?? '').toUpperCase() !== 'US' || !state) return null;
  if (!STATE_NAMES.has(String(state).toLowerCase())) return null;
  return city && region.city ? `${q}, ${region.city}, ${state}` : `${q}, ${state}`;
}

/** Nominatim search params, biased (never bounded) to a box around `near`. */
export function nominatimAddressParams(query, near = null, limit = 5) {
  const params = {
    q: clean(query),
    format: 'jsonv2',
    addressdetails: '1',
    limit: String(Math.min(10, Math.max(1, Math.round(Number(limit) || 5)))),
  };
  const lat = Number(near?.lat);
  const lon = Number(near?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 89) {
    const r = (v) => String(Number(v.toFixed(2)));
    const w = Math.max(-180, lon - 0.5);
    const e = Math.min(180, lon + 0.5);
    params.viewbox = `${r(w)},${r(lat + 0.5)},${r(e)},${r(lat - 0.5)}`;
  }
  return params;
}

const text = (v, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Nominatim jsonv2 (with addressdetails) -> Places: "number street", then where. */
export function nominatimPlaces(json) {
  const out = [];
  for (const r of Array.isArray(json) ? json : []) {
    const lat = Number(r?.lat);
    const lon = Number(r?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) continue;
    const a = r.address ?? {};
    const street = [a.house_number, a.road]
      .map((x) => text(x))
      .filter(Boolean)
      .join(' ');
    // Without address details: "46211, Jackson Street, Indio, ..." leads with
    // the bare number; join it to the street.
    const parts = text(r.display_name, 300)
      .split(',')
      .map((x) => x.trim());
    const lead = /^\d+[a-z]?$/i.test(parts[0] ?? '')
      ? parts.slice(0, 2).join(' ')
      : parts[0];
    const name = street || text(r.name) || lead;
    if (!name) continue;
    const where = [
      a.city ?? a.town ?? a.village ?? a.hamlet ?? a.suburb,
      a.state,
      a.postcode,
    ]
      .map((x) => text(x, 60))
      .filter(Boolean);
    out.push({
      id: `osm:${text(r.osm_type, 10).charAt(0).toUpperCase()}${text(String(r.osm_id ?? ''), 20) || `${lat},${lon}`}`,
      name,
      detail: [...new Set(where)].join(', '),
      lat,
      lon,
      kind: a.house_number ? 'address' : text(r.type, 40) || 'place',
    });
  }
  return out;
}

// Nominatim's policy forbids type-ahead use: it is asked only once a query
// has stood this long (a newer search, or the caller's abort, cancels it).
const NOMINATIM_SETTLE_MS = 700;
let addressSeq = 0;
const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
function settle(ms, signal) {
  return new Promise((resolve) => {
    if (!(ms > 0)) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** A Census answer this broad (the state-wide cap) may have missed the local one. */
const CENSUS_BROAD = 20;
/** "Near" for the follow-up question: the user's own town and neighbours. */
const NEAR_KM = 50;

/**
 * Address lookups for a numbered query, as Places. Census for a US address,
 * then (only when it found no such house number, and once the query has
 * stood still) Nominatim around the user. Never throws for a provider
 * failure: the other providers still answer.
 * @param {{ getJson: Function }} proxyClient
 * @param {string} query
 * @param {{ near?: {lat:number, lon:number}|null, signal?: AbortSignal,
 *   region?: (near: object) => Promise<object|null>, settleMs?: number }} [opts]
 */
export async function lookupAddress(
  proxyClient,
  query,
  { near = null, signal, region, settleMs = NOMINATIM_SETTLE_MS } = {},
) {
  const a = parseAddress(query);
  if (!proxyClient || !a) return [];
  const mine = (addressSeq += 1);
  const regionOf = region ?? ((n) => regionNear(proxyClient, n));
  // Not aborted with this search: the answer is remembered for the next one.
  const where = near && !a.region ? await regionOf(near).catch(() => null) : null;
  if (signal?.aborted) throw abortError();
  let found = [];
  const ask = async (line) => {
    try {
      return parseCensus(
        await proxyClient.getJson(CENSUS_FEED, CENSUS_PATH, {
          params: censusParams(line),
          signal,
        }),
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      return [];
    }
  };
  const line = censusAddress(query, where);
  if (line) {
    found = await ask(line);
    const nearest = near
      ? Math.min(...found.map((p) => distanceKm(near.lat, near.lon, p.lat, p.lon)))
      : 0;
    if (found.length >= CENSUS_BROAD && nearest > NEAR_KM && where?.city) {
      const cityLine = censusAddress(query, where, { city: true });
      if (cityLine) found = [...(await ask(cityLine)), ...found];
    }
  }
  const hasNumber = found.some((p) => p.number === a.number);
  if (!hasNumber) {
    await settle(settleMs, signal);
    if (signal?.aborted) throw abortError();
    if (mine !== addressSeq) return found; // a newer search is under way
    try {
      found = found.concat(
        nominatimPlaces(
          await proxyClient.getJson('nominatim', '/search', {
            params: nominatimAddressParams(query, near),
            signal,
          }),
        ),
      );
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  return found;
}
