// Shodan styling + cards. Counts span many orders of magnitude, so size and
// colour are on a log scale. Pure (no Cesium), shared with the terminal.

const logCount = (count) => Math.log10(Math.max(1, count || 0));

export function shodanPixelSize(count) {
  return Math.min(42, 8 + logCount(count) * 5);
}

export function shodanColorHex(count) {
  const l = logCount(count);
  if (l < 2) return '#5fd3ff';
  if (l < 4) return '#e3d357';
  if (l < 5) return '#e3a857';
  return '#ff5a3f';
}

/** 1234567 -> "1.2M", 45600 -> "45.6K". */
export function compactCount(n) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
}

/** Facet values as one row: "443 (1.2M), 80 (900K), ...". */
export const facetText = (list, n = 5) =>
  list.length
    ? list
        .slice(0, n)
        .map((f) => `${f.value} (${compactCount(f.count)})`)
        .join(', ')
    : '—';

/** Rows for one country's facets (a /host/count narrowed to the country). */
export function shodanFacetRows({ ports = [], orgs = [], products = [] }) {
  return [
    ['Top ports', facetText(ports)],
    ['Top operators', facetText(orgs, 3)],
    ['Top products', facetText(products, 3)],
  ];
}

export function describeShodan(n) {
  if (n.type === 'shodan-host') return describeShodanHost(n);
  const m = n.meta;
  const rows = [
    ['Country', m.country],
    ['Exposed hosts', (m.count ?? 0).toLocaleString('en-US')],
  ];
  if (m.total > 0)
    rows.push(['Share', `${((100 * m.count) / m.total).toFixed(1)}% of the snapshot`]);
  if (m.rank) rows.push(['Rank', `#${m.rank}`]);
  if (m.snapshot) rows.push(['Snapshot', m.snapshot]);
  return {
    id: n.id,
    title: m.country,
    subtitle: 'exposed hosts (Shodan snapshot, awareness only)',
    rows,
    links: [{ label: 'Shodan', url: 'https://www.shodan.io' }],
  };
}

/** A host from the opt-in sample: what Shodan indexed for it. */
export function describeShodanHost(n) {
  const m = n.meta;
  const rows = [
    ['Ports', m.ports?.length ? m.ports.join(', ') : '—'],
    ['Operator', m.org || m.isp || '—'],
  ];
  if (m.asn) rows.push(['ASN', m.asn]);
  if (m.products?.length) rows.push(['Products', m.products.slice(0, 3).join(', ')]);
  if (m.hostnames?.length) rows.push(['Hostnames', m.hostnames.slice(0, 3).join(', ')]);
  rows.push(['Location', [m.city, m.country].filter(Boolean).join(', ') || '—']);
  if (m.snapshot) rows.push(['Snapshot', m.snapshot]);
  return {
    id: n.id,
    title: m.ip,
    subtitle: 'host in the Shodan sample (indexed, never contacted)',
    rows,
    links: [{ label: 'Shodan host', url: `https://www.shodan.io/host/${m.ip}` }],
  };
}

export const shodanSearchText = (n) =>
  n.type === 'shodan-host'
    ? `${n.meta.ip} ${n.meta.org ?? ''} ${(n.meta.hostnames ?? []).join(' ')}`
    : n.meta.country;
