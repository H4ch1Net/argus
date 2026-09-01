// Classify a query string as an OSINT asset. Pure and tested. GUARDRAIL: the
// only asset kinds are network assets (IP, ASN, domain); a query is never a
// person. This is the gate that keeps the console asset-focused: anything that
// does not parse as an asset falls through to ordinary place/entity search.

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
// A permissive IPv6 check: hex groups and/or a '::' compression, nothing else.
const IPV6 = /^(?=.*:)(?:[0-9a-f]{0,4}:){1,7}[0-9a-f]{0,4}$/i;
const ASN = /^as\s?(\d{1,10})$/i;
// A dotted hostname with a plausible TLD (letters, 2+). Not exhaustive; enough to
// distinguish "example.com" from a callsign or a place name.
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * @param {string} raw
 * @returns {{ kind: 'ip'|'asn'|'domain', value: string } | null}
 */
export function classifyAsset(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (IPV4.test(s)) return { kind: 'ip', value: s };
  // Guard IPv6 against bare integers / times: require at least two colons.
  if (s.includes(':') && (s.match(/:/g) || []).length >= 2 && IPV6.test(s)) {
    return { kind: 'ip', value: s.toLowerCase() };
  }
  const asn = s.match(ASN);
  if (asn) return { kind: 'asn', value: `AS${asn[1]}` };
  if (DOMAIN.test(s)) return { kind: 'domain', value: s.toLowerCase() };
  return null;
}
