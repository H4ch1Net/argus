// Dev-only mock Shodan source: a /host/count-shaped country facet so the density
// map is demonstrable without a Shodan key or a running proxy. Dev-gated +
// dynamic-imported.

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

export function createShodanMockSource() {
  return async () => ({
    total: COUNTRY_COUNTS.reduce((s, [, c]) => s + c, 0),
    matches: [],
    facets: { country: COUNTRY_COUNTS.map(([value, count]) => ({ value, count })) },
  });
}
