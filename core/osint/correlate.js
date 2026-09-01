import {
  parseGeo,
  parseNetworkInfo,
  parseAsOverview,
  firstForwardIpv4,
} from './lookup.js';

// Asset correlation (Pillar 3): show ONE asset across several passive sources at
// once, the composite infrastructure picture. This is the "triangulation" the plan
// means: MULTI-SOURCE correlation (routing + registry + exposure), never locating
// a person and never multi-point geo scatter (public geo is too coarse to be
// meaningful, so relationships are shown as sourced facts, not scattered dots).
//
// Sources: RIPEstat (network-info, as-overview, announced-prefixes, geo, dns-chain)
// and, when configured, a credit-free Shodan single-host lookup for exposure.
// Certificate Transparency joins in the CT/BGP stage. All reads of already-public
// indexes; nothing is sent at a host; inputs are assets, never people.

export function allAnnouncedPrefixes(json, limit = 8) {
  const arr = json?.data?.prefixes;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((p) => p.prefix)
    .filter(Boolean)
    .slice(0, limit);
}

export function announcedPrefixCount(json) {
  const arr = json?.data?.prefixes;
  return Array.isArray(arr) ? arr.length : 0;
}

export function parseShodanHost(json) {
  if (!json || typeof json !== 'object') return null;
  return {
    ports: Array.isArray(json.ports) ? json.ports : [],
    hostnames: Array.isArray(json.hostnames) ? json.hostnames : [],
    tags: Array.isArray(json.tags) ? json.tags : [],
    vulns: json.vulns && typeof json.vulns === 'object' ? Object.keys(json.vulns) : [],
    org: json.org || json.isp || null,
    country: json.country_name || null,
  };
}

export function createCorrelator({ proxyClient }) {
  const ripe = (call, resource, signal) =>
    proxyClient.getJson('ripestat', `/data/${call}/data.json`, {
      params: { resource },
      signal,
    });

  // Resolve the asset to a geolocatable network resource (an IP, or a prefix for
  // an ASN), which every other source keys off.
  async function resolveResource(asset, signal) {
    if (asset.kind === 'ip') return asset.value;
    if (asset.kind === 'domain') {
      const chain = await ripe('dns-chain', asset.value, signal).catch(() => null);
      return chain ? firstForwardIpv4(chain, asset.value) : null;
    }
    if (asset.kind === 'asn') {
      const pfx = await ripe('announced-prefixes', asset.value, signal).catch(() => null);
      return allAnnouncedPrefixes(pfx, 1)[0] || null;
    }
    return null;
  }

  return async function correlate(asset, signal) {
    const resource = await resolveResource(asset, signal);
    if (!resource) return null;

    const [geoJson, netJson] = await Promise.all([
      ripe('maxmind-geo-lite', resource, signal).catch(() => null),
      ripe('network-info', resource, signal).catch(() => null),
    ]);
    const geo = geoJson ? parseGeo(geoJson) : null;
    const net = netJson ? parseNetworkInfo(netJson) : null;
    const asn =
      asset.kind === 'asn' ? asset.value : net?.asns?.[0] ? `AS${net.asns[0]}` : null;

    const [asJson, prefixesJson, shodanJson] = await Promise.all([
      asn ? ripe('as-overview', asn, signal).catch(() => null) : null,
      asn ? ripe('announced-prefixes', asn, signal).catch(() => null) : null,
      asset.kind !== 'asn'
        ? proxyClient
            .getJson('shodan', `/shodan/host/${resource}`, { signal })
            .catch(() => null)
        : null,
    ]);
    const as = asJson ? parseAsOverview(asJson) : null;
    const shodan = shodanJson ? parseShodanHost(shodanJson) : null;

    const sections = [];
    const routing = [];
    if (net?.prefix) routing.push(['Prefix', net.prefix]);
    if (asn) routing.push(['ASN', asn]);
    if (as?.holder) routing.push(['Operator', as.holder]);
    if (prefixesJson)
      routing.push(['Announced prefixes', String(announcedPrefixCount(prefixesJson))]);
    if (routing.length) sections.push({ title: 'Routing (RIPEstat)', rows: routing });

    const sample = allAnnouncedPrefixes(prefixesJson, 6);
    if (sample.length > 1) {
      sections.push({
        title: 'Announced prefixes (sample)',
        rows: sample.map((p, i) => [`#${i + 1}`, p]),
      });
    }

    if (shodan) {
      const rows = [];
      if (shodan.ports.length)
        rows.push(['Open ports', shodan.ports.slice(0, 14).join(', ')]);
      if (shodan.hostnames.length)
        rows.push(['Hostnames', shodan.hostnames.slice(0, 3).join(', ')]);
      if (shodan.tags.length) rows.push(['Tags', shodan.tags.join(', ')]);
      if (shodan.vulns.length) rows.push(['CVEs flagged', String(shodan.vulns.length)]);
      if (shodan.org) rows.push(['Org', shodan.org]);
      if (rows.length) sections.push({ title: 'Exposure (Shodan)', rows });
    }

    const sources = ['RIPEstat', ...(shodan ? ['Shodan'] : [])];
    const id = `corr:${asset.kind}:${asset.value}`;
    const place = geo ? [geo.city, geo.country].filter(Boolean).join(', ') : '';
    const topRows = [];
    if (asset.kind === 'domain' && resource !== asset.value) {
      topRows.push(['Resolves to', resource]);
    }
    if (place) topRows.push(['Location', place]);
    topRows.push([
      'Coordinates',
      geo ? `${geo.latitude.toFixed(2)}, ${geo.longitude.toFixed(2)}` : '—',
    ]);

    return {
      id,
      kind: asset.kind,
      value: asset.value,
      variant: 'correlated',
      position: geo ? { longitude: geo.longitude, latitude: geo.latitude } : null,
      card: {
        id,
        title: asset.value,
        subtitle: `${asset.kind} · correlated across ${sources.join(' + ')}`,
        rows: topRows,
        sections,
      },
      sources,
    };
  };
}
