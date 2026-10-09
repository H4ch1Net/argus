// US street addresses: the U.S. Census Bureau Geocoder (onelineaddress,
// Public_AR_Current benchmark) through the proxy feed 'census-geocoder'.
// Keyless and public domain (a US Government work). Pure: params and parsing.
//
// Live-tested Oct 2026: "46211 Jackson street" alone finds nothing, but with
// the state ("..., CA" or "..., California") it answers the one address in
// Indio, CA, its position interpolated along the TIGER/Line street range. A
// street address common across a state ("100 Main St, CA") answers up to 50
// matches, statewide.

export const CENSUS_FEED = 'census-geocoder';
export const CENSUS_PATH = '/locations/onelineaddress';
export const CENSUS_BENCHMARK = 'Public_AR_Current';
export const CENSUS_ATTRIBUTION =
  'US addresses: U.S. Census Bureau Geocoder (public domain)';

/** Proxy params for one address line (the proxy pins exactly these three). */
export function censusParams(address) {
  return {
    address: String(address ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200),
    benchmark: CENSUS_BENCHMARK,
    format: 'json',
  };
}

// Kept upper case: state codes, directions, and ordinals' suffixes stay readable.
const KEEP_UPPER = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW', 'PO']);

/** "46211 JACKSON ST" -> "46211 Jackson St"; "MCKINLEY" -> "Mckinley". */
export function titleWords(s) {
  return String(s ?? '')
    .split(' ')
    .map((w) =>
      KEEP_UPPER.has(w) || /^\d/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase(),
    )
    .join(' ');
}

/**
 * Census answer -> Places: { id, name: "46211 Jackson St", detail: "Indio, CA
 * 92201", lat, lon, kind: 'address', number: '46211' }.
 */
export function parseCensus(json) {
  const matches = json?.result?.addressMatches;
  const out = [];
  for (const m of Array.isArray(matches) ? matches : []) {
    const lon = Number(m?.coordinates?.x);
    const lat = Number(m?.coordinates?.y);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const line = String(m.matchedAddress ?? '')
      .trim()
      .slice(0, 160);
    if (!line) continue;
    // "46211 JACKSON ST, INDIO, CA, 92201": street, city, state, ZIP.
    const [street, city, state, zip] = line.split(',').map((s) => s.trim());
    const number = /^(\d+[A-Z]?)\b/.exec(street ?? '')?.[1]?.toLowerCase() ?? null;
    out.push({
      id: `census:${String(m.tigerLine?.tigerLineId ?? '').slice(0, 20)}:${number ?? ''}:${lat.toFixed(5)},${lon.toFixed(5)}`,
      name: titleWords(street),
      detail: [titleWords(city ?? ''), [state, zip].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(', '),
      lat,
      lon,
      kind: 'address',
      number,
    });
  }
  return out;
}
