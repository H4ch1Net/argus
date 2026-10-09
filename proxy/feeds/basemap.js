// Feed registry, basemap: OpenFreeMap's OpenStreetMap vector tiles, which the
// ctOS vector basemap (core/scene/vector/) draws in the browser. Same Feed
// shape as proxy/feeds.js (see its typedefs); spread into that list.
//
// OpenFreeMap (openfreemap.org) is free and keyless, with no registration and
// no request limits; tiles follow the OpenMapTiles schema (attribution
// "OpenFreeMap, (c) OpenMapTiles, data (c) OpenStreetMap contributors", shown
// on the globe and in DATA CREDITS). Live-tested Oct 2026: the TileJSON at
// /planet names a dated tile set (/planet/20261004_113936_pt/{z}/{x}/{y}.pbf,
// zooms 0 to 14, CORS open, cached for years by its CDN since a dated set
// never changes). The TileJSON is kept 6 hours (a new set appears weekly);
// tiles a week, with a month of stale fallback and a byte cap so a phone's
// proxy stays small.

import { UA, exactPath, MINUTE, HOUR } from './common.js';
import { pinnedQuery } from './earth.js';

const DAY = 24 * HOUR;

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    id: 'openfreemap',
    baseUrl: 'https://tiles.openfreemap.org',
    methods: ['GET'],
    allowPaths: [exactPath('/planet')],
    allowQuery: pinnedQuery({}),
    headers: { ...UA, accept: 'application/json' },
    governor: { ratePerMinute: 20 },
    cache: { ttlMs: 6 * HOUR, staleMs: 30 * DAY, maxEntries: 2 },
  },
  {
    id: 'openfreemap-tiles',
    baseUrl: 'https://tiles.openfreemap.org',
    methods: ['GET'],
    // A dated tile set, zooms 0 to 14, one tile.
    allowPaths: [/^\/planet\/\d{8}_\d{6}_pt\/(?:\d|1[0-4])\/\d{1,5}\/\d{1,5}\.pbf$/],
    allowQuery: pinnedQuery({}),
    headers: UA,
    queue: { concurrency: 8, maxWaitMs: MINUTE, maxQueued: 400 },
    governor: { ratePerMinute: 900 },
    cache: { ttlMs: 7 * DAY, staleMs: 30 * DAY, maxEntries: 3000, maxBytes: 48e6 },
  },
];
