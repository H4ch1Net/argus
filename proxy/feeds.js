// Feed registry: the allowlist of upstreams the proxy is permitted to reach.
//
// The relay can ONLY forward to a feed defined here, addressed by its `id`. The
// browser never supplies a target host, only a feed id plus a sub-path, so this
// registry is the entire set of reachable upstreams. That is what keeps the
// proxy from being an open proxy (no SSRF surface) and enforces the guardrail:
// it reads configured, already-public indexes only.
//
// Phase 2 ships this EMPTY. Real feeds arrive with the phases that use them
// (OpenSky in Phase 3, etc.). The shape is documented below so adding one is
// config, not new code.
//
// @typedef {Object} InjectRule
// @property {string} secret            env var name holding the secret value (server side only)
// @property {'header'|'query'} as      inject the secret as a request header or query param
// @property {string} name              header or query-param name
// @property {string} [template]        wraps the value, e.g. 'Bearer {value}' (default '{value}')
// @property {boolean} [required=true]  if true, a missing secret makes the feed respond 502
//
// @typedef {Object} Feed
// @property {string} id                url segment: /feed/<id>/...
// @property {string} baseUrl           upstream origin + base path (http allowed for LAN/bare-IP feeds)
// @property {string[]} [methods]       allowed HTTP methods (default ['GET'])
// @property {Array<RegExp|string>} [allowPaths]  optional sub-path allowlist (tested against the upstream pathname)
// @property {InjectRule[]} [inject]    static secrets injected server side
// @property {OAuth2Auth} [auth]        OAuth2 client-credentials (Bearer token brokered server side)
// @property {Record<string,string>} [headers]  static request headers (e.g. a User-Agent an API requires)
// @property {object} [governor]        rate / credit limits (see lib/governor.js)
// @property {{ ttlMs: number, staleMs?: number }} [cache]  reuse 200 GET bodies for ttlMs;
//                                      serve the last good one for staleMs when the upstream fails
// @property {string} [baseUrlEnv]      env var that may point the feed at another instance
// @property {boolean} [localOnly]      upstream exists only when baseUrlEnv names a host on
//                                      this machine or the LAN (e.g. a home SDR receiver)
// @property {boolean} [imageOnly]      a still-image feed: anything but an image/* body is refused
// @property {boolean} [enabled=true]
//
// @typedef {Object} OAuth2Auth
// @property {'oauth2'} type
// @property {string} tokenUrl          token endpoint
// @property {string} clientId          ENV VAR NAME holding the client id (not the value)
// @property {string} clientSecret      ENV VAR NAME holding the client secret (not the value)

import { UA, exactPath, MINUTE, HOUR } from './feeds/common.js';
import { feeds as spaceFeeds } from './feeds/space.js';
import { feeds as earthFeeds } from './feeds/earth.js';
import { feeds as navFeeds } from './feeds/nav.js';
import { feeds as cameraFeeds } from './feeds/cameras.js';
import { feeds as webcamFeeds } from './feeds/webcams.js';
import { feeds as imageryFeeds } from './feeds/imagery.js';
import { feeds as trafficFeeds } from './feeds/traffic.js';
import { feeds as contextFeeds } from './feeds/context.js';

// Feeds added after the core set live in per-area modules beside this file
// (proxy/feeds/*.js), each exporting its own array in the same Feed shape.

const NOWCOAST_LAYERS = [
  'global_longwave_imagery_mosaic',
  'goes_longwave_imagery',
  'conus_base_reflectivity_mosaic',
  'ldn_lightning_strike_density',
];

/** @type {Feed[]} */
export const feeds = [
  {
    // Flights (OpenSky Network). Verified Aug 2026: OAuth2 client-credentials,
    // 30-min tokens, /states/all is viewport-bound and credit-metered (1-4
    // credits/query by bbox area), so the client always sends a bounding box.
    id: 'opensky',
    baseUrl: 'https://opensky-network.org/api',
    methods: ['GET'],
    allowPaths: [/^\/api\/states\b/],
    auth: {
      type: 'oauth2',
      tokenUrl:
        'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
      clientId: 'OPENSKY_CLIENT_ID',
      clientSecret: 'OPENSKY_CLIENT_SECRET',
    },
  },
  {
    // Flights, keyless fallback (adsb.lol, a community ADS-B aggregator listed in
    // the master plan beside OpenSky). Used only when no OpenSky client is
    // configured, so the default-on flights layer works with zero keys. Its v2 API
    // follows the ADSBExchange/readsb schema. Two queries only: the viewport area
    // (/v2/lat/../lon/../dist/.., centre + radius <= 250 nm) and the global list
    // of aircraft flagged military (/v2/mil), both as the reference project uses
    // them. NOT re-verified at build time (egress was blocked): the public API
    // was keyless with a feeder key announced for later. ODbL, credit "adsb.lol".
    id: 'adsblol',
    baseUrl: 'https://api.adsb.lol',
    methods: ['GET'],
    allowPaths: [
      /^\/v2\/lat\/-?\d+(\.\d+)?\/lon\/-?\d+(\.\d+)?\/dist\/\d+$/,
      /^\/v2\/mil$/,
    ],
    headers: UA,
    governor: { ratePerMinute: 30 },
    cache: { ttlMs: 10_000, staleMs: 2 * MINUTE },
  },
  {
    // Earthquakes (USGS). Keyless, CORS-enabled, refreshed every minute. No auth;
    // the proxy still fronts it for one consistent HTTPS origin on mobile.
    id: 'usgs-quakes',
    baseUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary',
    methods: ['GET'],
    allowPaths: [/^\/earthquakes\/feed\/v1\.0\/summary\/.+\.geojson$/],
    cache: { ttlMs: MINUTE, staleMs: HOUR },
  },
  {
    // Satellites (CelesTrak GP/TLE). Keyless. Verified Aug 2026: a
    // one-download-per-update-cycle policy (~2h) applies, so each group is cached
    // here for 2 hours however many clients ask. CelesTrak refuses bulk groups
    // to clients without a descriptive User-Agent (per the reference project).
    id: 'celestrak',
    baseUrl: 'https://celestrak.org/NORAD/elements',
    methods: ['GET'],
    allowPaths: [/^\/NORAD\/elements\/gp\.php$/],
    headers: UA,
    cache: { ttlMs: 2 * HOUR, staleMs: 3 * 24 * HOUR },
  },
  {
    // Fires (NASA FIRMS). Verified Aug 2026: MAP_KEY goes in the URL path;
    // 5000 transactions / 10 min, and global VIIRS queries return 30k-100k+
    // rows/day, so the client always sends a viewport bbox. Free MAP_KEY.
    id: 'firms',
    baseUrl: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv',
    methods: ['GET'],
    allowPaths: [/^\/api\/area\/csv\//],
    inject: [{ secret: 'FIRMS_MAP_KEY', as: 'pathPrefix' }],
  },
  {
    // OSM Overpass (landmarks, surveillance-infrastructure locations, data
    // centres, mapped installations). Keyless, but slow and rate-limited, so the
    // client queries viewport-bounded and caches hard. The QL is passed as the
    // ?data= query param. Public instances refuse anonymous clients (the
    // reference project saw 406s), so the request names this app and a contact
    // URL, and OVERPASS_URL can point it at another instance, such as one you
    // run (any URL ending in /api works, e.g. https://overpass.example/api).
    id: 'overpass',
    baseUrl: 'https://overpass-api.de/api',
    baseUrlEnv: 'OVERPASS_URL',
    methods: ['GET'],
    // Judged against the default base path even when OVERPASS_URL re-points it.
    allowPaths: [/^\/api\/interpreter$/],
    headers: UA,
    governor: { ratePerMinute: 20 },
  },
  {
    // Shodan (exposed-device awareness). Verified Aug 2026: /host/count with
    // facets does NOT consume query credits; /host/search does. Visualization/
    // awareness-only, built on cached snapshots, never live search-on-pan. The
    // budget governor is live so a session can never burn the monthly credits.
    id: 'shodan',
    baseUrl: 'https://api.shodan.io',
    methods: ['GET'],
    // /host/count (facets) and /host/<ip> (single-host lookup) are credit-free
    // per the verified membership terms; /host/search consumes a query credit.
    allowPaths: [/^\/shodan\/host\/(count|search)/, /^\/shodan\/host\/[0-9a-fA-F.:]+$/],
    inject: [{ secret: 'SHODAN_API_KEY', as: 'query', name: 'key' }],
    governor: {
      ratePerMinute: 30,
      creditBudget: 90, // margin under the 100/month membership
      creditWindowMs: 30 * 24 * 60 * 60 * 1000,
      creditCost: (path) => (path.includes('/search') ? 1 : 0),
    },
  },
  {
    // Place geocoding (OSM Nominatim) for global search fly-to. Keyless, but its
    // usage policy requires a valid User-Agent and at most ~1 req/sec, so the
    // proxy sets a UA and the governor caps the rate; the client debounces too.
    id: 'nominatim',
    baseUrl: 'https://nominatim.openstreetmap.org',
    methods: ['GET'],
    allowPaths: [/^\/search/, /^\/reverse$/],
    headers: UA,
    governor: { ratePerMinute: 40 },
  },
  {
    // Coastlines for the terminal shell's map: Natural Earth land outlines (public
    // domain) as packaged by the world-atlas project, pinned to one version. A
    // static, keyless file fetched once and cached on disk by the client.
    id: 'basemap',
    baseUrl: 'https://cdn.jsdelivr.net',
    methods: ['GET'],
    allowPaths: [/^\/npm\/world-atlas@2\.0\.2\/land-(110m|50m)\.json$/],
    governor: { ratePerMinute: 10 },
    cache: { ttlMs: 24 * HOUR },
  },
  {
    // RIPEstat data API (OSINT query console). Keyless, public, passive: it reads
    // already-published registry/routing/geo indexes (network-info, as-overview,
    // announced-prefixes, maxmind-geo-lite, dns-chain). Inputs are ASSETS (IP,
    // prefix, ASN, domain), never people. No packets are sent at any host.
    id: 'ripestat',
    baseUrl: 'https://stat.ripe.net/data',
    methods: ['GET'],
    allowPaths: [
      /^\/data\/(network-info|as-overview|announced-prefixes|maxmind-geo-lite|dns-chain)\/data\.json$/,
    ],
    governor: { ratePerMinute: 60 },
  },
  {
    // Your own ADS-B receiver (dump1090 / readsb / tar1090 aircraft.json), e.g. an
    // RTL-SDR on the Kali box: LOCAL_ADSB_URL=http://localhost:8080/data. It must
    // be on this machine or the LAN (localOnly); without it the feed is simply
    // not configured. Reading your own decoder is as passive as it gets.
    id: 'local-adsb',
    baseUrl: 'http://localhost:8080/data',
    baseUrlEnv: 'LOCAL_ADSB_URL',
    localOnly: true,
    methods: ['GET'],
    allowPaths: [/^\/data\/aircraft\.json$/],
  },
  // --- Layers ported from the reference project (bilawalsidhu/gods-eye-view) ---
  // Endpoints, parameters and terms below are as that project uses them (read
  // from its source, Oct 2026); egress was blocked here, so none was re-fetched
  // at build time. Re-check terms before relying on one.

  {
    // Public radio stations with coordinates (Radio Browser). Keyless; the
    // directory data is public domain (PDDL 1.0); each broadcaster's stream keeps
    // its own terms. all.api.radio-browser.info is the round-robin name for the
    // community mirrors; RADIO_BROWSER_URL can pin one (e.g. https://de1.api.radio-browser.info).
    // GET /json/url/<uuid> is Radio Browser's listen counter (the tuner sends
    // one when a station starts playing; per the reference implementation, not
    // live-tested here). The cache below means one count per station per 45
    // minutes however often it is re-tuned, and the clicks share the governor.
    id: 'radiobrowser',
    baseUrl: 'https://all.api.radio-browser.info',
    baseUrlEnv: 'RADIO_BROWSER_URL',
    methods: ['GET'],
    allowPaths: [
      /^\/json\/stations\/search$/,
      /^\/json\/url\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    ],
    headers: UA,
    governor: { ratePerMinute: 10 },
    cache: { ttlMs: 45 * MINUTE, staleMs: 7 * 24 * HOUR },
  },
  {
    // Rocket launches (Launch Library 2, The Space Devs). Keyless at 15 calls per
    // hour; an optional LL2_API_TOKEN raises that. Cached 15 minutes, and the
    // governor caps upstream calls at 12 an hour so the free tier is never hit.
    // Besides the list, one launch's detailed record (/launches/<uuid>/, with its
    // timeline and orbit, for the reconstructed replay) is fetched on demand
    // inside the same budget. The detail path is per the reference
    // implementation, not live-tested here.
    id: 'll2',
    baseUrl: 'https://ll.thespacedevs.com/2.3.0',
    methods: ['GET'],
    allowPaths: [
      /^\/2\.3\.0\/launches\/?$/,
      /^\/2\.3\.0\/launches\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/,
    ],
    headers: UA,
    inject: [
      {
        secret: 'LL2_API_TOKEN',
        as: 'header',
        name: 'Authorization',
        template: 'Token {value}',
        required: false,
      },
    ],
    governor: { ratePerMinute: 3, creditBudget: 12, creditWindowMs: HOUR, creditCost: 1 },
    cache: { ttlMs: 15 * MINUTE, staleMs: 24 * HOUR },
  },
  {
    // Active tropical cyclones (NOAA National Hurricane Center). Keyless, public
    // domain; NHC sends no CORS headers, so it has to come through here.
    id: 'nhc',
    baseUrl: 'https://www.nhc.noaa.gov',
    methods: ['GET'],
    allowPaths: [/^\/CurrentStorms\.json$/],
    headers: UA,
    cache: { ttlMs: 5 * MINUTE, staleMs: 12 * HOUR },
  },
  {
    // Observed weather imagery (NOAA nowCOAST GeoServer WMS): global and GOES
    // infrared clouds, the US radar mosaic, lightning density. Keyless, public
    // domain (NOAA disclaimer). Only the three observation services are
    // reachable. GetCapabilities (time discovery for the weather timeline) and
    // timed GetMap are per the reference implementation, not live-tested here.
    id: 'nowcoast',
    baseUrl: 'https://nowcoast.noaa.gov/geoserver/observations',
    methods: ['GET'],
    allowPaths: [
      /^\/geoserver\/observations\/(weather_radar|satellite|lightning_detection)\/ows$/,
    ],
    // `ows` is GeoServer's generic endpoint (WMS, WFS, WCS, WPS), so the query
    // is pinned too: tile-sized WMS GetMap of the imagery layers (optionally at
    // one explicit UTC instant, never an interval or period), or a WMS 1.3.0
    // GetCapabilities with no other parameter.
    allowQuery: (q) => {
      const keys = [...q.keys()].map((k) => k.toLowerCase());
      if (new Set(keys).size !== keys.length) return false;
      const get = (name) => {
        for (const [k, v] of q) if (k.toLowerCase() === name) return v;
        return null;
      };
      if (!/^wms$/i.test(get('service') ?? '')) return false;
      const request = get('request') ?? '';
      if (/^getcapabilities$/i.test(request)) {
        return keys.length === 3 && get('version') === '1.3.0';
      }
      const time = get('time');
      const instant =
        time === null ||
        (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(time) &&
          Number.isFinite(Date.parse(time)));
      return (
        /^getmap$/i.test(request) &&
        instant &&
        NOWCOAST_LAYERS.includes(get('layers')) &&
        Number(get('width')) <= 512 &&
        Number(get('height')) <= 512
      );
    },
    headers: UA,
    governor: { ratePerMinute: 600 },
    // Capabilities refresh every 2 minutes and may stand in for an hour if
    // nowCOAST fails. Tiles share the entry budget; an exact-time frame never
    // changes, but the relay's cache is per feed (one TTL), so tiles keep the
    // same 2 minutes and Cesium keeps the loaded ones.
    cache: { ttlMs: 2 * MINUTE, staleMs: HOUR, maxEntries: 48 },
  },
  {
    // Submarine cables and landing points (TeleGeography's public map GeoJSON).
    // CC BY-NC-SA 3.0: non-commercial use with attribution ("TeleGeography,
    // submarinecablemap.com"). Fetched at run time, never copied into the repo.
    id: 'cables',
    baseUrl: 'https://www.submarinecablemap.com/api/v3',
    methods: ['GET'],
    allowPaths: [
      /^\/api\/v3\/(cable\/cable-geo|landing-point\/landing-point-geo)\.json$/,
    ],
    headers: UA,
    cache: { ttlMs: 24 * HOUR, staleMs: 30 * 24 * HOUR },
  },
  // Public traffic cameras (keyless). Each network has a catalogue feed (cached
  // 15 minutes) and an image-only feed for its stills, fetched when a camera's
  // card is opened. Only the documented catalogue and still paths are reachable.
  {
    // Caltrans, one JSON catalogue per district, stills on the same host.
    id: 'caltrans',
    baseUrl: 'https://cwwp2.dot.ca.gov/data',
    methods: ['GET'],
    allowPaths: [/^\/data\/d\d{1,2}\/cctv\/cctvStatusD\d{2}\.json$/],
    headers: UA,
    cache: { ttlMs: 15 * MINUTE, staleMs: 24 * HOUR },
  },
  {
    id: 'caltrans-img',
    baseUrl: 'https://cwwp2.dot.ca.gov/data',
    methods: ['GET'],
    allowPaths: [/^\/data\/d\d{1,2}\/cctv\/image\/[\w.-]+\/[\w.-]+\.jpg$/],
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // Transport for London JamCams ("Powered by TfL Open Data"); an optional
    // TFL_APP_KEY only raises TfL's anonymous rate limit.
    id: 'tfl',
    baseUrl: 'https://api.tfl.gov.uk',
    methods: ['GET'],
    allowPaths: [/^\/Place\/Type\/JamCam$/],
    headers: UA,
    inject: [{ secret: 'TFL_APP_KEY', as: 'query', name: 'app_key', required: false }],
    cache: { ttlMs: 15 * MINUTE, staleMs: 24 * HOUR },
  },
  {
    id: 'tfl-img',
    baseUrl: 'https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk',
    methods: ['GET'],
    allowPaths: [/^\/jamcams\.tfl\.gov\.uk\/[\d.]+\.jpg$/],
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  {
    // Statens vegvesen (Norway), OGC API Features; NLOD.
    id: 'vegvesen',
    baseUrl: 'https://ogckart-sn1.atlas.vegvesen.no/ogc/features/v1/collections',
    methods: ['GET'],
    allowPaths: [/^\/ogc\/features\/v1\/collections\/datex_3_1:CctvSimple\/items$/],
    headers: UA,
    cache: { ttlMs: 15 * MINUTE, staleMs: 24 * HOUR },
  },
  {
    id: 'vegvesen-img',
    baseUrl: 'https://kamera.atlas.vegvesen.no/api/images',
    methods: ['GET'],
    allowPaths: [/^\/api\/images\/[A-Za-z0-9_-]{1,40}$/],
    headers: UA,
    governor: { ratePerMinute: 120 },
  },
  // Bikeshare stations (GBFS station_information + station_status), keyless
  // and attribution-only per system; core/layers/bikeshare/systems.js holds the
  // registry. One feed per host, reaching only those two files.
  ...[
    ['gbfs-lyft', 'https://gbfs.lyft.com/gbfs/2.3', '/(bkn|chi|dca-cabi|bay)/en'],
    ['gbfs-bluebikes', 'https://gbfs.bluebikes.com/gbfs/en', ''],
    ['gbfs-biketown', 'https://gbfs.biketownpdx.com/gbfs/2.3/en', ''],
    ['gbfs-cogo', 'https://gbfs.cogobikeshare.com/gbfs/2.3/en', ''],
    ['gbfs-austin', 'https://austin.publicbikesystem.net/customer/gbfs/v2/en', ''],
    ['gbfs-honolulu', 'https://hon.publicbikesystem.net/customer/gbfs/v2/en', ''],
    ['gbfs-bcycle', 'https://gbfs.bcycle.com', '/bcycle_[a-z]+'],
  ].map(([id, baseUrl, sub]) => ({
    id,
    baseUrl,
    methods: ['GET'],
    allowPaths: [
      new RegExp(
        `^${new URL(baseUrl).pathname.replace(/\/$/, '').replace(/\./g, '\\.')}${sub}/station_(information|status)\\.json$`,
      ),
    ],
    headers: UA,
    governor: { ratePerMinute: 20 },
    cache: { ttlMs: 30_000, staleMs: 10 * MINUTE },
  })),
  // Live transit vehicles (GTFS-Realtime VehiclePositions, protobuf). One feed
  // per agency, all keyless; core/layers/transit/agencies.js holds their
  // coverage areas. Polled at most every 15 s per agency, shared via the cache.
  ...[
    ['gtfsrt-mbta', 'https://cdn.mbta.com/realtime', '/VehiclePositions.pb'],
    [
      'gtfsrt-capmetro',
      'https://data.texas.gov/download/eiei-9rpf',
      '/application%2Foctet-stream',
    ],
    [
      'gtfsrt-metrotransit',
      'https://svc.metrotransit.org/mtgtfs',
      '/vehiclepositions.pb',
    ],
    ['gtfsrt-hsl', 'https://realtime.hsl.fi/realtime/vehicle-positions/v2', '/hsl'],
    ['gtfsrt-ovapi', 'https://gtfs.ovapi.nl/nl', '/vehiclePositions.pb'],
    [
      'gtfsrt-entur',
      'https://api.entur.io/realtime/v1/gtfs-rt',
      '/vehicle-positions',
      // Entur asks every client to identify itself as <company>-<application>.
      { 'et-client-name': 'h4ch1net-argus' },
    ],
    [
      'gtfsrt-translink',
      'https://gtfsrt.api.translink.com.au/api/realtime/seq',
      '/VehiclePositions',
    ],
  ].map(([id, baseUrl, path, extraHeaders]) => ({
    id,
    baseUrl,
    methods: ['GET'],
    allowPaths: [exactPath(new URL(baseUrl).pathname.replace(/\/$/, '') + path)],
    headers: { ...UA, ...extraHeaders },
    governor: { ratePerMinute: 8 },
    cache: { ttlMs: 12_000, staleMs: 10 * MINUTE },
  })),
  ...spaceFeeds,
  ...earthFeeds,
  ...navFeeds,
  ...cameraFeeds,
  ...webcamFeeds,
  ...imageryFeeds,
  ...trafficFeeds,
  ...contextFeeds,
];
