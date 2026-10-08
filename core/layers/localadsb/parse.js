// Your own receivers: the aircraft.json that dump1090, readsb and tar1090 serve
// for 1090 MHz ADS-B, and that dump978-fa + skyaware978 serve for 978 MHz UAT
// (the same { now: seconds, aircraft: [...] } readsb schema adsb.lol uses).
// Parsed with the flights layer's adsb.lol reader, so cards, trails and
// interpolation are identical. Positions not heard for a minute are dropped.
// When both bands are configured, one aircraft heard on both is one entity: the
// newest position wins and meta.bands lists every band that heard it in the
// last minute, so the card reads "1090 MHz + 978 MHz UAT". Merge adapted from
// gods-eye-view src/sources/adsbRecords.js mergeLocalAdsbRecords (MIT). Pure.

import { parseAdsb } from '../flights/parse.js';
import { aircraftToNormalized } from '../flights/format.js';

const STALE_POSITION_S = 60;
const HEARD_S = 60; // heard on a band = any message on it within the last minute

export const BAND_ORDER = Object.freeze(['1090', '978']);
const BAND_NAME = { 1090: '1090 MHz', 978: '978 MHz UAT' };
const normBand = (b) => (String(b) === '978' ? '978' : '1090');

/** "1090 MHz", "978 MHz UAT", or "1090 MHz + 978 MHz UAT". */
export const bandsLabel = (bands) =>
  BAND_ORDER.filter((b) => bands?.includes(b))
    .map((b) => BAND_NAME[b])
    .join(' + ') || BAND_NAME[1090];

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// One receiver document -> per-aircraft records: { key, band, heard, entity,
// positionAt }. `entity` is null when there is no fresh position (the aircraft
// still counts as heard on this band). A '~' address is not an ICAO address
// (TIS-B / ADS-R track files): it keeps its '~' in the id so it never merges
// with, or collides with, a real ICAO address.
function readBand(doc, band) {
  const list = Array.isArray(doc?.aircraft) ? doc.aircraft : [];
  const nowS = finite(doc?.now);
  const nowMs = nowS === null ? undefined : nowS * 1000;
  const out = [];
  for (const a of list) {
    if (!a || typeof a.hex !== 'string' || !a.hex.trim()) continue;
    const nonIcao = a.hex.trim().startsWith('~');
    const seen = finite(a.seen);
    const seenPos = finite(a.seen_pos);
    const fresh = seenPos === null || seenPos <= STALE_POSITION_S;
    const [parsed] = fresh ? parseAdsb({ ac: [a], now: nowMs }).aircraft : [];
    const key = (nonIcao ? '~' : '') + a.hex.trim().replace(/^~/, '').toLowerCase();
    const positionAt = parsed && nowS !== null ? (nowS - (seenPos ?? 0)) * 1000 : null;
    out.push({
      key,
      band,
      heard: Boolean(parsed) || seen === null || seen <= HEARD_S,
      positionAt,
      parsed: parsed
        ? {
            ...parsed,
            id: key,
            timePosition: positionAt === null ? null : positionAt / 1000,
          }
        : null,
    });
  }
  return out;
}

/**
 * Merge records from several bands: one entity per address, the newest
 * position wins (a tie keeps the first band in BAND_ORDER), annotated with
 * every band that heard the aircraft.
 */
function merge(records, demo) {
  const best = new Map();
  const bands = new Map();
  for (const r of records) {
    if (r.heard) {
      if (!bands.has(r.key)) bands.set(r.key, new Set());
      bands.get(r.key).add(r.band);
    }
    if (!r.parsed) continue;
    const cur = best.get(r.key);
    if (!cur || (r.positionAt ?? -Infinity) > (cur.positionAt ?? -Infinity))
      best.set(r.key, r);
  }
  const out = [];
  for (const [key, r] of best) {
    const heard = BAND_ORDER.filter((b) => bands.get(key)?.has(b) || b === r.band);
    const source = demo ? 'demo (simulated)' : `your receiver (${bandsLabel(heard)})`;
    out.push({
      ...aircraftToNormalized({ ...r.parsed, band: r.band, bands: heard, source }),
      type: 'aircraft-local',
    });
  }
  return out;
}

/**
 * @param {{ now?: number, aircraft?: object[], demo?: boolean }
 *   | { demo?: boolean, feeds: { band: '1090'|'978', payload: object }[] }} payload
 *   one receiver document, or the combined shape createLocalReceiverSource returns
 * @param {{ band?: '1090'|'978' }} [opts] the band of a single document
 * @returns {object[]} normalized entities (type 'aircraft-local'); meta.bands
 *   lists the bands that heard each aircraft, meta.band the one whose position is shown
 */
export function parseLocalAdsb(payload, { band = '1090' } = {}) {
  if (Array.isArray(payload?.feeds)) {
    const records = payload.feeds.flatMap((f) =>
      f && f.payload ? readBand(f.payload, normBand(f.band)) : [],
    );
    return merge(
      records,
      Boolean(payload.demo || payload.feeds.some((f) => f?.payload?.demo)),
    );
  }
  return merge(readBand(payload, normBand(band)), Boolean(payload?.demo));
}

/** True when an aircraft was heard only on 978 MHz UAT (for a distinct ring style). */
export const uatOnly = (n) =>
  Array.isArray(n?.meta?.bands) && n.meta.bands.length === 1 && n.meta.bands[0] === '978';
