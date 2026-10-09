// Curated Shodan snapshot queries. Awareness only (locked decision): the
// Shodan layer shows how many hosts the world exposes for ONE of these fixed
// queries, as a density map by country, from the credit-free /host/count
// endpoint, cached for hours at the proxy. There is no free-text search: the
// proxy pins its 'shodan' feed to exactly these query strings (optionally
// narrowed to one country for a card's facets), so nothing can search live,
// on pan or otherwise. Categories are infrastructure exposure (remote access,
// industrial control, databases), never cameras or people. Pure.

const snap = (id, short, label, query) => Object.freeze({ id, short, label, query });

export const SHODAN_SNAPSHOTS = Object.freeze([
  snap('web', 'WEB', 'Web servers (Apache)', 'product:"Apache httpd"'),
  snap('rdp', 'RDP', 'Remote desktop (RDP)', 'port:3389'),
  snap('vnc', 'VNC', 'Remote desktop (VNC)', 'port:5900'),
  snap('telnet', 'TELNET', 'Telnet', 'port:23'),
  snap('smb', 'SMB', 'File sharing (SMB)', 'port:445'),
  snap('databases', 'DB', 'Databases (Mongo, Elastic, Redis)', 'port:27017,9200,6379'),
  snap('mqtt', 'MQTT', 'IoT brokers (MQTT)', 'port:1883'),
  snap('modbus', 'MODBUS', 'Industrial control (Modbus)', 'port:502'),
  snap('s7', 'S7', 'Industrial control (Siemens S7)', 'port:102'),
  snap('bacnet', 'BACNET', 'Building control (BACnet)', 'port:47808'),
]);

export const DEFAULT_SNAPSHOT = 'web';
/** Facets for the density map (top 200 countries). */
export const SHODAN_COUNTRY_FACETS = 'country:200';
/** Facets for one country's card: top ports, operators, products. */
export const SHODAN_DETAIL_FACETS = 'port:8,org:8,product:8';

/** A snapshot by id (the default for an unknown id). */
export function snapshotById(id) {
  return (
    SHODAN_SNAPSHOTS.find((s) => s.id === id) ??
    SHODAN_SNAPSHOTS.find((s) => s.id === DEFAULT_SNAPSHOT)
  );
}

const CC = /^[A-Z]{2}$/;

/**
 * Params for /shodan/host/count: the snapshot's query (optionally narrowed to
 * a country, ISO 3166 alpha-2) with the density or the detail facets.
 */
export function shodanCountParams(snapshot, country = null) {
  const cc = country ? String(country).toUpperCase() : null;
  if (cc && !CC.test(cc)) throw new Error(`not a country code: ${country}`);
  return {
    query: cc ? `${snapshot.query} country:${cc}` : snapshot.query,
    facets: cc ? SHODAN_DETAIL_FACETS : SHODAN_COUNTRY_FACETS,
  };
}

/** Params for the opt-in host sample (one page, minified; one query credit). */
export function shodanSampleParams(snapshot) {
  return { query: snapshot.query, page: '1', minify: 'true' };
}
