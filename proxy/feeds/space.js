// Feed registry, Air and space: satellites, launches, aircraft extras (traces,
// enrichment) and your own 978 MHz UAT receiver.
// Same Feed shape as proxy/feeds.js (see its typedefs); spread into that list.
//
// Ported from the reference project (bilawalsidhu/gods-eye-view, MIT code):
// endpoints, paths and limits below are as that project uses them, read from
// its source. Egress was blocked when these were added, so every feed here is
// per the reference implementation, not live-tested here. Re-check each
// upstream's terms before relying on it.
// eslint-disable-next-line no-unused-vars
import { UA, exactPath, MINUTE, HOUR } from './common.js';

// Static files and single-record lookups take no query: refusing one keeps each
// cache key to its path (no cache-busting) and the request to the pinned shape.
const noQuery = (q) => [...q.keys()].length === 0;

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    // Your own 978 MHz UAT receiver (dump978-fa + skyaware978), which serves the
    // same aircraft.json shape as dump1090 / readsb. Set LOCAL_UAT_URL, e.g.
    // http://localhost:8978/data or http://piaware.local/skyaware978/data. It
    // must be on this machine or the LAN (localOnly); without it the feed is not
    // configured. Reading your own decoder is passive.
    // Per the reference implementation, not live-tested here.
    id: 'local-uat',
    baseUrl: 'http://localhost:8978/data',
    baseUrlEnv: 'LOCAL_UAT_URL',
    localOnly: true,
    methods: ['GET'],
    allowPaths: [/^\/data\/aircraft\.json$/],
  },
  {
    // Military 24 h trace backfill (adsb.lol globe_history trace files). Keyless,
    // ODbL ("adsb.lol"), sends no CORS headers. UNDOCUMENTED path: it is the file
    // the adsb.lol map itself loads, so it may change without notice. Exactly one
    // file shape is reachable: /data/traces/<last 2 hex>/trace_full_<hex>.json,
    // where <hex> is a 24-bit address, optionally '~'-prefixed (non-ICAO), and the
    // directory must be that address's last two hex digits. Fetched only when a
    // military aircraft is selected, so the governor and a 60 s cache are plenty.
    // Per the reference implementation, not live-tested here.
    id: 'adsblol-trace',
    baseUrl: 'https://adsb.lol',
    methods: ['GET'],
    allowPaths: [/^\/data\/traces\/([0-9a-f]{2})\/trace_full_~?[0-9a-f]{4}\1\.json$/],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 10 },
    cache: { ttlMs: MINUTE, staleMs: 10 * MINUTE, maxEntries: 8 },
  },
  {
    // Aircraft enrichment (adsbdb, a free community API): ICAO hex -> type and
    // registration, airline callsign -> airline and route airports. Keyless; no
    // licence or quota is published, so the governor drips at about 5/s and each
    // answer is cached 24 h (the client queue also keeps 24 h answers, misses
    // included, so a 404 is asked once a day at most).
    // Terms: the ROUTE data "may not be copied, published, or incorporated into
    // other databases without the explicit permission of David J Taylor,
    // Edinburgh" (route data credit: David Taylor, Edinburgh, and Jim Mason,
    // Glasgow). Argus shows it on the selected aircraft's card at run time only:
    // never persisted, exported, or redistributed.
    // People guardrail: adsbdb answers carry registered_owner* fields (which can
    // name a private person). core/layers/flights/enrich.js drops them.
    // Per the reference implementation, not live-tested here.
    id: 'adsbdb',
    baseUrl: 'https://api.adsbdb.com',
    methods: ['GET'],
    allowPaths: [
      /^\/v0\/aircraft\/[0-9a-fA-F]{6}$/,
      /^\/v0\/callsign\/[A-Za-z0-9]{2,8}$/,
    ],
    allowQuery: noQuery,
    headers: UA,
    governor: { ratePerMinute: 300 },
    cache: { ttlMs: 24 * HOUR, staleMs: 7 * 24 * HOUR, maxEntries: 48 },
  },
];
