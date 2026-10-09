import { snapshotById } from './snapshots.js';

// Dev-only mock Shodan source: a /host/count-shaped country facet so the density
// map is demonstrable without a Shodan key or a running proxy, scaled per
// snapshot, plus a demo host sample on documentation addresses (RFC 5737) when
// the sample is switched on. Dev-gated + dynamic-imported.

const COUNTRY_COUNTS = [
  ['US', 1_250_000],
  ['CN', 890_000],
  ['DE', 410_000],
  ['IN', 210_000],
  ['GB', 230_000],
  ['JP', 180_000],
  ['RU', 160_000],
  ['FR', 140_000],
  ['NL', 130_000],
  ['BR', 120_000],
  ['CA', 90_000],
  ['AU', 70_000],
  ['KR', 65_000],
  ['SG', 40_000],
  ['ZA', 22_000],
];

const SCALE = { web: 1, rdp: 0.4, vnc: 0.12, telnet: 0.3, smb: 0.25, databases: 0.08 };

function countJson(snapshotId) {
  const k = SCALE[snapshotId] ?? 0.02;
  const country = COUNTRY_COUNTS.map(([value, count]) => ({
    value,
    count: Math.round(count * k),
  }));
  return {
    total: country.reduce((s, c) => s + c.count, 0),
    matches: [],
    facets: { country },
    demo: true,
  };
}

const PLACES = [
  [37.77, -122.42, 'US', 'San Francisco'],
  [40.71, -74.0, 'US', 'New York'],
  [51.51, -0.13, 'GB', 'London'],
  [50.11, 8.68, 'DE', 'Frankfurt'],
  [52.37, 4.9, 'NL', 'Amsterdam'],
  [35.68, 139.69, 'JP', 'Tokyo'],
  [1.35, 103.82, 'SG', 'Singapore'],
  [-33.87, 151.21, 'AU', 'Sydney'],
];
const DOC_NETS = ['192.0.2.', '198.51.100.', '203.0.113.'];

function sampleJson() {
  const matches = [];
  for (let i = 0; i < 24; i += 1) {
    const [lat, lon, cc, city] = PLACES[i % PLACES.length];
    matches.push({
      ip_str: `${DOC_NETS[i % 3]}${10 + i}`,
      port: [22, 80, 443, 3389, 8080][i % 5],
      org: 'DEMO-NET (synthetic)',
      asn: `AS${64500 + i}`,
      hostnames: [],
      product: i % 2 ? 'Apache httpd' : null,
      location: {
        latitude: lat + (i % 5) * 0.01,
        longitude: lon - (i % 3) * 0.01,
        country_code: cc,
        city,
      },
    });
  }
  return { total: matches.length, matches, demo: true };
}

export function createShodanMockSource({
  getSnapshot = () => 'web',
  getSample = () => false,
} = {}) {
  return async () => {
    const snapshot = snapshotById(getSnapshot());
    return {
      count: countJson(snapshot.id),
      snapshot,
      sample: getSample() ? sampleJson() : null,
      demo: true,
    };
  };
}

/** Demo facets for a country card (dev only). */
export function mockCountryFacets(country) {
  const seed = [...String(country)].reduce((s, ch) => s + ch.charCodeAt(0), 0);
  const facets = {
    ports: [80, 443, 22, 8080, 3389].map((value, i) => ({
      value: String(value),
      count: Math.round(50_000 / (i + 1) + seed),
    })),
    orgs: ['DEMO-NET A', 'DEMO-NET B', 'DEMO-NET C'].map((value, i) => ({
      value,
      count: 9000 - i * 2000,
    })),
    products: ['Apache httpd', 'nginx', 'OpenSSH'].map((value, i) => ({
      value,
      count: 20_000 - i * 5000,
    })),
  };
  return facets;
}
