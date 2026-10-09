// Shodan InternetDB: what Shodan's own scanners have already indexed for one
// IP (open ports, CPEs, hostnames, tags, known vulnerabilities), keyless,
// through the proxy's pinned 'internetdb' feed (proxy/feeds/exposure.js).
// GUARDRAIL: a read of a public index; nothing is sent to the IP, and the
// input is a network asset, never a person. Pure parsing plus a small cached
// lookup; shared by the OSINT console, the target cards and the terminal.

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^(?=.*:.*:)[0-9a-f:]{2,39}$/i;

/** True for a literal IPv4 or IPv6 address. */
export const isIp = (s) => typeof s === 'string' && (IPV4.test(s) || IPV6.test(s));

const strings = (v, max = 64) =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max) : [];

/**
 * InternetDB JSON -> { ip, ports, cpes, hostnames, tags, vulns }, or null for
 * its "No information available" answer and anything malformed.
 */
export function parseInternetDb(json) {
  if (!json || typeof json !== 'object' || !isIp(json.ip)) return null;
  return {
    ip: json.ip,
    ports: (Array.isArray(json.ports) ? json.ports : [])
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
      .sort((a, b) => a - b),
    cpes: strings(json.cpes),
    hostnames: strings(json.hostnames),
    tags: strings(json.tags),
    vulns: strings(json.vulns, 2000).filter((v) => /^CVE-\d{4}-\d{4,7}$/.test(v)),
  };
}

/** CVE ids newest first (by year, then number). */
export function sortCves(list) {
  const key = (c) => {
    const m = /^CVE-(\d{4})-(\d+)$/.exec(c);
    return m ? Number(m[1]) * 1e8 + Number(m[2]) : 0;
  };
  return [...list].sort((a, b) => key(b) - key(a));
}

/** "cpe:/a:apache:http_server:2.4.7" -> "apache http_server 2.4.7". */
export function cpeText(cpe) {
  const parts = String(cpe)
    .replace(/^cpe:\/?[aoh]?:?/i, '')
    .split(':');
  return parts.filter(Boolean).join(' ');
}

const list = (arr, n) =>
  arr.length > n ? `${arr.slice(0, n).join(', ')} +${arr.length - n}` : arr.join(', ');

/** Card rows for an InternetDB answer (or the "nothing indexed" row). */
export function internetDbRows(info) {
  if (!info) return [['InternetDB', 'nothing indexed for this IP']];
  const rows = [];
  rows.push(['Open ports', info.ports.length ? list(info.ports, 16) : 'none indexed']);
  rows.push([
    'Known CVEs',
    info.vulns.length
      ? `${info.vulns.length} (${list(sortCves(info.vulns), 3)})`
      : 'none listed',
  ]);
  if (info.tags.length) rows.push(['Tags', info.tags.join(', ')]);
  if (info.hostnames.length) rows.push(['Hostnames', list(info.hostnames, 3)]);
  if (info.cpes.length) rows.push(['Software', list(info.cpes.map(cpeText), 3)]);
  return rows;
}

/** A card section for an IP's exposure. */
export const internetDbSection = (info) => ({
  title: 'Exposure (InternetDB)',
  rows: internetDbRows(info),
});

/** The IP a record's meta names, if any (meta.ip, meta.ip_str, meta.address). */
export function ipOf(meta) {
  for (const v of [meta?.ip, meta?.ip_str, meta?.address]) if (isIp(v)) return v;
  return null;
}

/**
 * A cached lookup through the proxy. Resolves to the parsed answer, or null
 * when InternetDB has nothing for the IP (its 404). Other failures reject.
 * peek(ip) answers synchronously from the cache: undefined when not looked up.
 * @param {{ getJson: Function }} proxyClient
 */
export function createInternetDbLookup(
  proxyClient,
  { now = () => Date.now(), ttlMs = 6 * 3600_000 } = {},
) {
  const cache = new Map(); // ip -> { value, at }
  const pending = new Map();
  const fresh = (ip) => {
    const hit = cache.get(ip);
    return hit && now() - hit.at < ttlMs ? hit : null;
  };
  async function lookup(ip, signal) {
    if (!isIp(ip)) throw new Error(`not an IP address: ${ip}`);
    const hit = fresh(ip);
    if (hit) return hit.value;
    if (pending.has(ip)) return pending.get(ip);
    const p = (async () => {
      let value = null;
      try {
        value = parseInternetDb(
          await proxyClient.getJson('internetdb', `/${ip}`, { signal }),
        );
      } catch (err) {
        if (err?.status !== 404) throw err;
      }
      cache.set(ip, { value, at: now() });
      while (cache.size > 500) cache.delete(cache.keys().next().value);
      return value;
    })();
    pending.set(ip, p);
    try {
      return await p;
    } finally {
      pending.delete(ip);
    }
  }
  lookup.peek = (ip) => {
    const hit = fresh(ip);
    return hit ? hit.value : undefined;
  };
  return lookup;
}
