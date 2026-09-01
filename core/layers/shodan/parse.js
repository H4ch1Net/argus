import { COUNTRY_CENTROIDS } from './countryCentroids.js';

// Parse a Shodan /shodan/host/count response (country facet) into density
// entities at country centroids. Population-level and credit-free by design
// (awareness-only, no individual hosts). Pure: no Cesium.

export function parseShodanFacets(json, facet = 'country') {
  const items = Array.isArray(json?.facets?.[facet]) ? json.facets[facet] : [];
  const out = [];
  for (const it of items) {
    const code = String(it.value || '').toUpperCase();
    const centroid = COUNTRY_CENTROIDS[code];
    if (!centroid || typeof it.count !== 'number') continue;
    out.push({
      id: `shodan-${facet}-${code}`,
      type: 'shodan-density',
      position: { longitude: centroid[1], latitude: centroid[0], altitude: 0 },
      meta: { country: code, count: it.count },
    });
  }
  return out;
}
