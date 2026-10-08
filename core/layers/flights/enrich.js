// Aircraft enrichment from adsbdb (api.adsbdb.com, through the proxy feed
// 'adsbdb'): an ICAO address -> type and registration, an airline callsign ->
// airline and route airports. Adapted from gods-eye-view
// server/providers/aircraft/enrichment.js and src/layers/flights/enrichment.js
// (MIT), which adapted it from skylight (MIT).
//
// PEOPLE GUARDRAIL: adsbdb's aircraft answer carries registered_owner* fields
// (owner name, country, operator flag), and an owner can be a private person.
// Parsing here is an ALLOWLIST: only the type code, ICAO type, manufacturer,
// model and registration are copied, so every registered_owner* field (and the
// photo links) is dropped before anything reaches a card, a search index or
// the terminal. The input is always an asset (an ICAO address, a callsign),
// never a person.
//
// TERMS: adsbdb publishes no licence or quota (hence the proxy governor and the
// 24 h caches). Its README says the ROUTE data "may not be copied, published, or
// incorporated into other databases without the explicit permission of David J
// Taylor, Edinburgh" (credit: David Taylor, Edinburgh, and Jim Mason, Glasgow).
// So route answers are shown on the selected aircraft's card at run time only:
// never persisted to disk, exported, shared in a scene link, or bundled.
//
// Pure: the proxy client is injected.

const HEX = /^[0-9a-f]{6}$/;
const CALLSIGN = /^[A-Z0-9]{2,8}$/;

const text = (v, max = 80) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Proxy sub-path for an aircraft lookup, or null (6-hex ICAO addresses only). */
export function aircraftPath(hex) {
  const h = String(hex ?? '')
    .trim()
    .toLowerCase();
  return HEX.test(h) ? `/v0/aircraft/${h}` : null;
}

/** Proxy sub-path for a route lookup, or null. */
export function callsignPath(callsign) {
  const c = String(callsign ?? '')
    .trim()
    .toUpperCase();
  return CALLSIGN.test(c) ? `/v0/callsign/${c}` : null;
}

/**
 * Airline-style callsigns only (three letters then a digit, e.g. BAW123):
 * general-aviation callsigns are registrations, which adsbdb has no route for.
 */
export const isAirlineCallsign = (cs) =>
  /^[A-Z]{3}\d[A-Z0-9]{0,4}$/.test(
    String(cs ?? '')
      .trim()
      .toUpperCase(),
  );

/**
 * adsbdb /v0/aircraft/<hex> -> the allowlisted aircraft fields, or null.
 * @returns {{ typeCode: string|null, icaoType: string|null, manufacturer: string|null,
 *   model: string|null, typeName: string|null, registration: string|null } | null}
 */
export function parseAdsbdbAircraft(json) {
  const a = json?.response?.aircraft;
  if (!a || typeof a !== 'object') return null;
  const icaoType = text(a.icao_type, 8);
  const manufacturer = text(a.manufacturer);
  const model = text(a.type);
  const out = {
    typeCode: icaoType,
    icaoType,
    manufacturer,
    model,
    typeName: manufacturer && model ? `${manufacturer} ${model}` : model,
    registration: text(a.registration, 16),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

function airport(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {
    iata: text(a.iata_code, 4),
    icao: text(a.icao_code, 4),
    name: text(a.name, 120),
    municipality: text(a.municipality),
    countryIso: text(a.country_iso_name, 3),
    latitude: num(a.latitude),
    longitude: num(a.longitude),
  };
  return out.iata || out.icao || out.name ? out : null;
}

/**
 * adsbdb /v0/callsign/<cs> -> airline name and route airports, or null.
 * Run-time display only (see the terms note above).
 * @returns {{ airline: string|null, origin: object, destination: object, midpoint: object|null } | null}
 */
export function parseAdsbdbRoute(json) {
  const fr = json?.response?.flightroute;
  const origin = airport(fr?.origin);
  const destination = airport(fr?.destination);
  if (!origin || !destination) return null;
  return {
    airline: text(fr.airline?.name),
    origin,
    destination,
    midpoint: airport(fr.midpoint),
  };
}

/** Queue keys for an aircraft: 'a:<hex>' and, for airline callsigns, 'c:<CS>'. */
export function enrichKeys(meta) {
  const hex = String(meta?.id ?? '').toLowerCase();
  const cs = String(meta?.callsign ?? '')
    .trim()
    .toUpperCase();
  return {
    aircraft: HEX.test(hex) ? `a:${hex}` : null,
    route: isAirlineCallsign(cs) ? `c:${cs}` : null,
  };
}

/**
 * The fetch function for the enrichment queue (enrichQueue.js): key -> parsed
 * answer, null for a known miss (adsbdb 404s an unknown aircraft or route, and
 * the queue caches that for 24 h), a rejection for anything else (retried later).
 * @param {{ getJson: Function }} proxyClient
 */
export function createAdsbdbFetcher(proxyClient) {
  return async (key, signal) => {
    const [kind, id] = [key.slice(0, 2), key.slice(2)];
    const path =
      kind === 'a:' ? aircraftPath(id) : kind === 'c:' ? callsignPath(id) : null;
    if (!path) return null;
    try {
      const json = await proxyClient.getJson('adsbdb', path, { signal });
      return kind === 'a:' ? parseAdsbdbAircraft(json) : parseAdsbdbRoute(json);
    } catch (err) {
      if (err?.status === 404) return null;
      throw err;
    }
  };
}

const place = (a) => a.iata || a.icao || a.name;

/**
 * Card rows for an enrichment (append to formatAircraft's rows). Live feed
 * values win: rows are only added for what the feed did not already say.
 * @param {object} meta  the aircraft's meta (formatAircraft input)
 * @param {{ aircraft?: object|null, route?: object|null }} enrichment
 * @returns {[string, string][]}
 */
export function enrichmentRows(meta, { aircraft = null, route = null } = {}) {
  const rows = [];
  if (aircraft?.typeName) rows.push(['Aircraft', aircraft.typeName]);
  if (aircraft?.registration && !meta?.registration)
    rows.push(['Registration', aircraft.registration]);
  if (aircraft?.typeCode && !meta?.typeCode) rows.push(['Type', aircraft.typeCode]);
  if (route?.airline) rows.push(['Airline', route.airline]);
  if (route) {
    const legs = [route.origin, route.midpoint, route.destination]
      .filter(Boolean)
      .map(place);
    rows.push(['Route', legs.join(' → ')]);
  }
  if (aircraft || route)
    rows.push(['Enrichment', 'adsbdb (route data: D. Taylor, J. Mason)']);
  return rows;
}
