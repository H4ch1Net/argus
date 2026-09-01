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
// @property {boolean} [enabled=true]
//
// @typedef {Object} OAuth2Auth
// @property {'oauth2'} type
// @property {string} tokenUrl          token endpoint
// @property {string} clientId          ENV VAR NAME holding the client id (not the value)
// @property {string} clientSecret      ENV VAR NAME holding the client secret (not the value)

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
    // Earthquakes (USGS). Keyless, CORS-enabled, refreshed every minute. No auth;
    // the proxy still fronts it for one consistent HTTPS origin on mobile.
    id: 'usgs-quakes',
    baseUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary',
    methods: ['GET'],
    allowPaths: [/^\/earthquakes\/feed\/v1\.0\/summary\/.+\.geojson$/],
  },
  {
    // Satellites (CelesTrak GP/TLE). Keyless. Verified Aug 2026: a
    // one-download-per-update-cycle policy (~2h) applies, so the client fetches
    // TLEs sparingly and caches; proxy-side caching lands with the budget
    // governor (Phase 13).
    id: 'celestrak',
    baseUrl: 'https://celestrak.org/NORAD/elements',
    methods: ['GET'],
    allowPaths: [/^\/NORAD\/elements\/gp\.php$/],
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
    // OSM Overpass (landmarks + surveillance-infrastructure locations). Keyless,
    // but slow and rate-limited, so the client queries viewport-bounded and
    // caches hard. The QL is passed as the ?data= query param.
    id: 'overpass',
    baseUrl: 'https://overpass-api.de/api',
    methods: ['GET'],
    allowPaths: [/^\/api\/interpreter$/],
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
    allowPaths: [/^\/search/],
    headers: { 'user-agent': 'Argus/0.1 (public-data globe; research)' },
    governor: { ratePerMinute: 40 },
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
];
