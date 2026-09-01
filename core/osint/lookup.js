// OSINT query-console lookups: given a classified asset, enrich + geolocate it
// from public passive indexes (RIPEstat data API) and return a plottable result.
// GUARDRAIL: passive only. Every call is a read of an already-published index
// (routing, registry, geo); nothing is sent at a target host, and the inputs are
// network assets (IP, prefix, ASN, domain), never people.
//
// The parsers are pure and unit-tested; createLookup wires them to the proxy.

export function parseGeo(json) {
  const loc = json?.data?.located_resources?.[0]?.locations?.[0];
  if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude))
    return null;
  return {
    latitude: loc.latitude,
    longitude: loc.longitude,
    country: loc.country || '',
    city: loc.city || '',
  };
}

export function parseNetworkInfo(json) {
  const d = json?.data || {};
  return { prefix: d.prefix || null, asns: Array.isArray(d.asns) ? d.asns : [] };
}

export function parseAsOverview(json) {
  const d = json?.data || {};
  return { holder: d.holder || null, announced: Boolean(d.announced) };
}

export function firstForwardIpv4(json, domain) {
  const nodes = json?.data?.forward_nodes || {};
  const list = nodes[domain] || Object.values(nodes)[0] || [];
  return list.find((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x)) || list[0] || null;
}

export function firstAnnouncedPrefix(json) {
  return json?.data?.prefixes?.[0]?.prefix || null;
}

// Build a result + card from the enrichment pieces.
function buildResult({ id, kind, value, subtitle, geo, net, as, extraRows = [] }) {
  const rows = [...extraRows];
  if (net?.prefix) rows.push(['Prefix', net.prefix]);
  if (net?.asns?.length) rows.push(['ASN', net.asns.map((a) => `AS${a}`).join(', ')]);
  if (as?.holder) rows.push(['Operator', as.holder]);
  const place = geo ? [geo.city, geo.country].filter(Boolean).join(', ') : '';
  if (place) rows.push(['Location', place]);
  rows.push([
    'Coordinates',
    geo ? `${geo.latitude.toFixed(2)}, ${geo.longitude.toFixed(2)}` : '—',
  ]);
  return {
    id,
    kind,
    value,
    position: geo ? { longitude: geo.longitude, latitude: geo.latitude } : null,
    card: { id, title: value, subtitle, rows },
    sources: ['RIPEstat'],
  };
}

export function createLookup(proxyClient) {
  const get = (call, resource, signal) =>
    proxyClient.getJson('ripestat', `/data/${call}/data.json`, {
      params: { resource },
      signal,
    });

  async function ipDetails(
    ip,
    signal,
    { value = ip, subtitle = 'IP address (passive lookup)' } = {},
  ) {
    const [geoJson, netJson] = await Promise.all([
      get('maxmind-geo-lite', ip, signal).catch(() => null),
      get('network-info', ip, signal).catch(() => null),
    ]);
    const geo = geoJson ? parseGeo(geoJson) : null;
    const net = netJson ? parseNetworkInfo(netJson) : null;
    let as = null;
    if (net?.asns?.length) {
      const asJson = await get('as-overview', `AS${net.asns[0]}`, signal).catch(
        () => null,
      );
      as = asJson ? parseAsOverview(asJson) : null;
    }
    return buildResult({ id: `ip:${value}`, kind: 'ip', value, subtitle, geo, net, as });
  }

  async function asnDetails(asn, signal) {
    const [asJson, prefixesJson] = await Promise.all([
      get('as-overview', asn, signal).catch(() => null),
      get('announced-prefixes', asn, signal).catch(() => null),
    ]);
    const as = asJson ? parseAsOverview(asJson) : null;
    const prefix = prefixesJson ? firstAnnouncedPrefix(prefixesJson) : null;
    const geoJson = prefix
      ? await get('maxmind-geo-lite', prefix, signal).catch(() => null)
      : null;
    const geo = geoJson ? parseGeo(geoJson) : null;
    return buildResult({
      id: `asn:${asn}`,
      kind: 'asn',
      value: asn,
      subtitle: 'Autonomous System (passive lookup)',
      geo,
      as,
      extraRows: prefix ? [['First prefix', prefix]] : [],
    });
  }

  async function domainDetails(domain, signal) {
    const chain = await get('dns-chain', domain, signal).catch(() => null);
    const ip = chain ? firstForwardIpv4(chain, domain) : null;
    if (!ip) {
      return buildResult({
        id: `domain:${domain}`,
        kind: 'domain',
        value: domain,
        subtitle: 'Domain (no A record resolved)',
        geo: null,
      });
    }
    const r = await ipDetails(ip, signal, {
      value: domain,
      subtitle: 'Domain (passive lookup)',
    });
    r.id = `domain:${domain}`;
    r.kind = 'domain';
    r.card.id = r.id;
    r.card.rows.unshift(['Resolves to', ip]);
    return r;
  }

  return async function lookup({ kind, value }, signal) {
    if (kind === 'ip') return ipDetails(value, signal);
    if (kind === 'asn') return asnDetails(value, signal);
    if (kind === 'domain') return domainDetails(value, signal);
    return null;
  };
}
