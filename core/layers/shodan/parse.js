import { COUNTRY_CENTROIDS } from './countryCentroids.js';

// Parse Shodan answers into layer entities. Pure: no Cesium.
//
//   /shodan/host/count (country facet)  -> density squares at country centroids:
//     population-level and credit-free (awareness only, no individual hosts)
//   /shodan/host/search (the opt-in host sample, one page, one query credit)
//     -> one point per host at Shodan's own geolocation of the IP
//
// Response shapes per the Shodan REST API documentation; /host/count with
// facets is { total, matches: [], facets: { country: [{ value, count }] } }.

export function parseShodanFacets(json, facet = 'country') {
  const items = Array.isArray(json?.facets?.[facet]) ? json.facets[facet] : [];
  const total = typeof json?.total === 'number' ? json.total : null;
  const out = [];
  let rank = 0;
  for (const it of items) {
    const code = String(it.value || '').toUpperCase();
    const centroid = COUNTRY_CENTROIDS[code];
    if (typeof it.count !== 'number') continue;
    rank += 1;
    if (!centroid) continue;
    out.push({
      id: `shodan-${facet}-${code}`,
      type: 'shodan-density',
      position: { longitude: centroid[1], latitude: centroid[0], altitude: 0 },
      meta: { country: code, count: it.count, total, rank },
    });
  }
  return out;
}

/** A facet's top values: [{ value, count }] (ports come back as numbers). */
export function parseShodanFacetList(json, facet, max = 8) {
  const items = Array.isArray(json?.facets?.[facet]) ? json.facets[facet] : [];
  return items
    .filter((it) => it && typeof it.count === 'number' && it.value != null)
    .slice(0, max)
    .map((it) => ({ value: String(it.value), count: it.count }));
}

const str = (v, max = 120) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const IP = /^(?:\d{1,3}\.){3}\d{1,3}$|^(?=.*:.*:)[0-9a-f:]{2,39}$/i;

/**
 * The host sample (/shodan/host/search, minified): one entry per IP with its
 * indexed ports, merged across that IP's services. Hosts Shodan could not
 * place are skipped (nothing to plot).
 */
export function parseShodanSample(json, max = 100) {
  const matches = Array.isArray(json?.matches) ? json.matches : [];
  const byIp = new Map();
  for (const m of matches) {
    const ip = str(m?.ip_str, 39);
    const lat = m?.location?.latitude;
    const lon = m?.location?.longitude;
    if (!ip || !IP.test(ip) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) continue;
    let h = byIp.get(ip);
    if (!h) {
      if (byIp.size >= max) continue;
      h = {
        ip,
        lat,
        lon,
        ports: [],
        products: [],
        org: str(m.org),
        isp: str(m.isp),
        asn: str(m.asn, 16),
        hostnames: (Array.isArray(m.hostnames) ? m.hostnames : [])
          .filter((x) => typeof x === 'string')
          .slice(0, 4),
        city: str(m.location?.city, 60),
        country: str(m.location?.country_code, 2),
      };
      byIp.set(ip, h);
    }
    if (Number.isInteger(m.port) && !h.ports.includes(m.port)) h.ports.push(m.port);
    const product = str(m.product, 60);
    if (product && !h.products.includes(product)) h.products.push(product);
  }
  return [...byIp.values()].map((h) => ({ ...h, ports: h.ports.sort((a, b) => a - b) }));
}

/**
 * The layer's raw answer -> entities: { count, snapshot, sample? } where
 * count is the /host/count JSON and sample the optional /host/search JSON.
 * A bare /host/count JSON (older callers, the dev mock) works too.
 */
export function shodanToNormalized(raw) {
  const count = raw?.count ?? raw;
  const label = raw?.snapshot?.label ?? null;
  // The dev mock says so, and the card shows DEMO (never "Shodan").
  const source = raw?.demo || count?.demo ? 'demo (simulated)' : 'Shodan';
  const density = parseShodanFacets(count, 'country');
  for (const n of density) Object.assign(n.meta, { snapshot: label, source });
  const hosts = raw?.sample
    ? parseShodanSample(raw.sample).map((h) => ({
        id: `shodan-host-${h.ip}`,
        type: 'shodan-host',
        position: { longitude: h.lon, latitude: h.lat, altitude: 0 },
        meta: { ...h, snapshot: label, source },
      }))
    : [];
  return [...density, ...hosts];
}
