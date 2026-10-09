// Feed registry, context layers: aurora and the K index (NOAA SWPC), air
// quality (Open-Meteo / CAMS), night lights for the day/night terminator (NASA
// GIBS), Tor relays (Onionoo) and GDELT events. Same Feed shape as
// proxy/feeds.js (see its typedefs); spread into that list.
//
// No network when the first four were added, so each is "per the provider's
// documentation, not live-tested here". Re-check terms before relying on one.
// The query builders live in core (Cesium-free): core/layers/aurora/parse.js,
// airquality/field.js, terminator/night.js, tor/parse.js, gdelt/parse.js;
// proxy/test/contextFeeds.test.js checks that what they build passes the pins.

import { UA, exactPath, MINUTE, HOUR } from './common.js';
import { pinnedQuery } from './earth.js';
import { createGdeltEventsProducer } from '../lib/gdelt.js';

// Kept equal to core by proxy/test/contextFeeds.test.js.
export const AQ_CURRENT = 'us_aqi,european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide';
export const ONIONOO_FIELDS =
  'nickname,fingerprint,country,country_name,as,as_name,flags,observed_bandwidth,latitude,longitude';

/** "51.5,-0.12,..." -> 2..64 numbers within +-max, at most 2 decimals; else null. */
function coordList(v, max) {
  if (typeof v !== 'string' || v.length > 1024) return null;
  const parts = v.split(',');
  if (parts.length < 2 || parts.length > 64) return null;
  const out = [];
  for (const p of parts) {
    if (!/^-?\d{1,3}(?:\.\d{1,2})?$/.test(p)) return null;
    const n = Number(p);
    if (Math.abs(n) > max) return null;
    out.push(n);
  }
  return out;
}

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    // Aurora (NOAA SWPC OVATION nowcast, a 1 degree global grid of the chance
    // of visible aurora, about 1 MB) and the planetary K index (1-minute
    // estimates). Keyless, US public domain under the NOAA disclaimer. SWPC
    // refreshes OVATION about every 5 minutes: cached 5 minutes here for every
    // client, and served stale for 2 hours if SWPC fails.
    // Per the provider's documentation, not live-tested here.
    id: 'swpc',
    baseUrl: 'https://services.swpc.noaa.gov/json',
    methods: ['GET'],
    allowPaths: [
      exactPath('/json/ovation_aurora_latest.json'),
      exactPath('/json/planetary_k_index_1m.json'),
    ],
    allowQuery: pinnedQuery({}),
    headers: UA,
    governor: { ratePerMinute: 12 },
    cache: { ttlMs: 5 * MINUTE, staleMs: 2 * HOUR, maxEntries: 4 },
  },
  {
    // Air quality (Open-Meteo Air Quality API: CAMS global and European
    // forecasts). Keyless; CC BY 4.0 with "Open-Meteo.com" and "contains
    // modified Copernicus Atmosphere Monitoring Service information"; free for
    // non-commercial use within a daily allowance in which each point counts as
    // one call. Pinned to one query: 2 to 64 coordinate pairs with 2 decimals,
    // the six current fields, UTC. At most 120 requests a day here, cached 30
    // minutes (the data is hourly).
    // Per the provider's documentation, not live-tested here.
    id: 'openmeteo-aq',
    baseUrl: 'https://air-quality-api.open-meteo.com/v1',
    methods: ['GET'],
    allowPaths: [exactPath('/v1/air-quality')],
    allowQuery: (q) => {
      const lat = coordList(q.get('latitude'), 80);
      const lon = coordList(q.get('longitude'), 180);
      return (
        pinnedQuery({
          latitude: () => lat !== null,
          longitude: () => lon !== null,
          current: AQ_CURRENT,
          timezone: 'UTC',
        })(q) && lat.length === lon.length
      );
    },
    headers: UA,
    governor: { ratePerMinute: 6, creditBudget: 120, creditWindowMs: 24 * HOUR },
    cache: { ttlMs: 30 * MINUTE, staleMs: 2 * HOUR, maxEntries: 32 },
  },
  {
    // Night lights for the day/night terminator: one global NASA Black Marble
    // (VIIRS_Black_Marble) image from the GIBS WMS (EPSG:4326, "best"). Keyless,
    // NASA open data, GIBS acknowledgement requested. The existing 'gibs' feed
    // (proxy/feeds/imagery.js) reaches only the HLS / VIIRS true-colour WMTS
    // tiles, so this is its own image-only feed, pinned to exactly one request
    // (the whole globe at 1024 x 512 or 2048 x 1024, PNG). The image is static:
    // cached a week, stale for a month.
    // Per the provider's documentation, not live-tested here.
    id: 'gibs-night',
    baseUrl: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best',
    methods: ['GET'],
    allowPaths: [exactPath('/wms/epsg4326/best/wms.cgi')],
    allowQuery: (q) =>
      pinnedQuery({
        SERVICE: 'WMS',
        REQUEST: 'GetMap',
        VERSION: '1.3.0',
        LAYERS: 'VIIRS_Black_Marble',
        STYLES: '',
        CRS: 'EPSG:4326',
        BBOX: '-90,-180,90,180',
        WIDTH: ['1024', '2048'],
        HEIGHT: ['512', '1024'],
        FORMAT: 'image/png',
      })(q) && Number(q.get('WIDTH')) === 2 * Number(q.get('HEIGHT')),
    imageOnly: true,
    headers: UA,
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: 7 * 24 * HOUR, staleMs: 30 * 24 * HOUR, maxEntries: 2 },
  },
  {
    // Tor relays (Tor Metrics Onionoo details: the running relays' published
    // descriptors). Keyless, CC BY 3.0 US ("The Tor Project"). Pinned to the
    // one query: running relays, a fixed list of public fields (never the
    // operator contact). Onionoo updates hourly: cached an hour, stale a day.
    // Per the provider's documentation, not live-tested here.
    id: 'onionoo',
    baseUrl: 'https://onionoo.torproject.org',
    methods: ['GET'],
    allowPaths: [exactPath('/details')],
    allowQuery: pinnedQuery({ type: 'relay', running: 'true', fields: ONIONOO_FIELDS }),
    headers: UA,
    governor: { ratePerMinute: 4 },
    cache: { ttlMs: HOUR, staleMs: 24 * HOUR, maxEntries: 2 },
  },
  {
    // GDELT events (GDELT 2.0 Event exports; the GEO 2.0 API this used is
    // gone, 404 since 2026). Not a relay: the proxy itself reads
    // lastupdate.txt and the latest 15-minute export.CSV.zip (plus the three
    // before it, once each) from data.gdeltproject.org over HTTPS, unzips and
    // filters them (proxy/lib/gdelt.js), and serves one JSON document at
    // /feed/gdelt-events/events.json. Keyless; GDELT terms allow use with a
    // citation and a link, and each linked article keeps its publisher's
    // terms. GUARDRAIL: fixed event classes only (protest, assault / fight /
    // mass violence, humanitarian aid) and never the actor columns; the client
    // sends no query at all. Rebuilt at most every 15 minutes (GDELT's own
    // cadence); a failed rebuild serves the last good document for 12 hours.
    // lastupdate.txt and an export were fetched live (Oct 2026); the
    // fetch from Node was not run here.
    id: 'gdelt-events',
    baseUrl: 'https://data.gdeltproject.org/gdeltv2',
    methods: ['GET'],
    allowPaths: [exactPath('/gdeltv2/events.json')],
    allowQuery: pinnedQuery({}),
    upstreamPaths: [
      exactPath('/gdeltv2/lastupdate.txt'),
      /^\/gdeltv2\/\d{14}\.export\.CSV\.zip$/,
    ],
    produce: createGdeltEventsProducer(),
    headers: UA,
    timeoutMs: 60_000,
    governor: { ratePerMinute: 6 },
    cache: { ttlMs: 15 * MINUTE, staleMs: 12 * HOUR, maxEntries: 2 },
  },
];
