// Feed registry, host exposure: Shodan (the snapshot density layer and host
// lookups) and Shodan InternetDB. Same Feed shape as proxy/feeds.js (see its
// typedefs); spread into that list.
//
// GUARDRAIL: every request reads Shodan's index of what its own scanners
// already saw. Nothing is sent to any host, the inputs are network assets
// (IP addresses, fixed queries), never people, and there is no free-text
// search: the Shodan feed only takes the curated snapshot queries below.

import { UA, HOUR } from './common.js';
import { pinnedQuery } from './earth.js';

const IPV4 = /^\/(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
// Hex groups and '::' only, with at least two colons (as core/osint/asset.js).
const IPV6 = /^\/(?=[^/]*:[^/]*:)[0-9a-fA-F:]{2,39}$/;

// The curated snapshot queries (core/layers/shodan/snapshots.js, kept equal by
// proxy/test/exposureFeeds.test.js) and their facet strings.
export const SHODAN_QUERIES = Object.freeze([
  'product:"Apache httpd"',
  'port:3389',
  'port:5900',
  'port:23',
  'port:445',
  'port:27017,9200,6379',
  'port:1883',
  'port:502',
  'port:102',
  'port:47808',
]);
export const SHODAN_FACETS = Object.freeze(['country:200', 'port:8,org:8,product:8']);

/** A curated query, alone or narrowed to one country ("<query> country:DE"). */
export function shodanQueryTextOk(v) {
  if (typeof v !== 'string') return false;
  if (SHODAN_QUERIES.includes(v)) return true;
  const m = / country:[A-Z]{2}$/.exec(v);
  return Boolean(m) && SHODAN_QUERIES.includes(v.slice(0, m.index));
}

/**
 * The relay checks the query before it knows the path, so this accepts the
 * union of the three request shapes the app makes, and nothing else:
 *   /shodan/host/count   query + facets          (credit-free snapshot)
 *   /shodan/host/search  query + page=1 + minify  (the opt-in host sample)
 *   /shodan/host/<ip>    nothing, or minify       (a host lookup)
 */
export function shodanQueryOk(q) {
  const keys = [...q.keys()].sort().join(',');
  if (new Set(q.keys()).size !== [...q.keys()].length) return false;
  if (keys === '' || (keys === 'minify' && q.get('minify') === 'true')) return true;
  if (!shodanQueryTextOk(q.get('query'))) return false;
  if (keys === 'facets,query') return SHODAN_FACETS.includes(q.get('facets'));
  if (keys === 'minify,page,query')
    return q.get('page') === '1' && q.get('minify') === 'true';
  return false;
}

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    // Shodan (exposed-device awareness). Verified Aug 2026: /host/count with
    // facets does NOT consume query credits; /host/search does (a filter or a
    // page past the first costs one), and /host/<ip> is credit-free. Built on
    // cached snapshots, never live search-on-pan: the query is pinned to the
    // curated list above, answers are cached 12 hours (a week stale when
    // Shodan fails or the budget is spent), and the governor keeps the
    // metered search under the monthly membership.
    id: 'shodan',
    baseUrl: 'https://api.shodan.io',
    methods: ['GET'],
    allowPaths: [
      /^\/shodan\/host\/(count|search)$/,
      /^\/shodan\/host\/[0-9a-fA-F.:]{2,39}$/,
    ],
    allowQuery: shodanQueryOk,
    inject: [{ secret: 'SHODAN_API_KEY', as: 'query', name: 'key' }],
    headers: UA,
    governor: {
      ratePerMinute: 30,
      creditBudget: 90, // margin under the 100/month membership
      creditWindowMs: 30 * 24 * HOUR,
      creditCost: (path) => (path.endsWith('/search') ? 1 : 0),
    },
    cache: { ttlMs: 12 * HOUR, staleMs: 7 * 24 * HOUR, maxEntries: 128 },
  },
  {
    // Shodan InternetDB: the open ports, CPEs, hostnames, tags and known
    // vulnerabilities Shodan holds for one IP. Keyless and free for
    // non-commercial use; it answers 404 {"detail":"No information
    // available"} for an IP it knows nothing about. Live-tested Oct 2026
    // (8.8.8.8, 1.1.1.1, 45.33.32.156 and an unknown IP; the answers are the
    // fixtures in core/osint/fixtures/internetdb.json). Pinned to one IP per
    // request, no query. Answers are cached a day (InternetDB itself refreshes
    // weekly) and may stand in for a week; at most 60 lookups a minute.
    id: 'internetdb',
    baseUrl: 'https://internetdb.shodan.io',
    methods: ['GET'],
    allowPaths: [IPV4, IPV6],
    allowQuery: pinnedQuery({}),
    headers: UA,
    governor: { ratePerMinute: 60 },
    cache: { ttlMs: 24 * HOUR, staleMs: 7 * 24 * HOUR, maxEntries: 512 },
  },
];
