// Dams as mapped in OpenStreetMap (ODbL), read through the shared Overpass
// client like the data-centre and installation layers. Facility locations and
// public engineering facts only. Pure: filters, card and search text.

/** Overpass selectors (bbox appended by the client): named dams, plus man_made=dam. */
export const DAM_FILTERS = ['nwr["waterway"="dam"]["name"]', 'nwr["man_made"="dam"]'];
/** Widest view (degrees) the layer queries; dams are dense in some regions. */
export const DAM_MAX_DEG = 3;

const coords = (n) =>
  `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`;

// A bare number is metres (the OSM default unit); anything else is shown as tagged.
const metres = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim().slice(0, 24);
  return /^\d+(\.\d+)?$/.test(s) ? `${s} m` : s;
};

function wikipediaLink(tag) {
  const m = /^([a-z]{2,3}(?:-[a-z]+)?):(.{1,200})$/i.exec(String(tag || ''));
  if (!m) return null;
  return {
    label: 'Wikipedia',
    url: `https://${m[1].toLowerCase()}.wikipedia.org/wiki/${encodeURIComponent(m[2].trim().replace(/ /g, '_'))}`,
  };
}

function wikidataLink(tag) {
  return /^Q\d{1,12}$/.test(String(tag || ''))
    ? { label: 'Wikidata', url: `https://www.wikidata.org/wiki/${tag}` }
    : null;
}

const osmLink = (n) =>
  n.meta.osmType && n.meta.osmId != null
    ? {
        label: 'View on OpenStreetMap',
        url: `https://www.openstreetmap.org/${n.meta.osmType}/${n.meta.osmId}`,
      }
    : null;

export function describeDam(n) {
  const t = n.meta.tags || {};
  const name = t.name || t['name:en'] || t.official_name;
  const power =
    t['generator:output:electricity'] || t['plant:output:electricity'] || null;
  return {
    id: n.id,
    title: name || 'Dam',
    subtitle: t.operator || '',
    rows: [
      ['Operator', t.operator || '—'],
      ['Height', metres(t.height) || '—'],
      ['Length', metres(t.length || t.width) || '—'],
      ['Built', t.start_date || '—'],
      ...(power ? [['Power output', String(power).slice(0, 24)]] : []),
      ...(t['ref:nid'] ? [['NID', String(t['ref:nid']).slice(0, 16)]] : []),
      ['Coordinates', coords(n)],
      ['Source', 'OpenStreetMap contributors (ODbL)'],
    ],
    links: [osmLink(n), wikipediaLink(t.wikipedia), wikidataLink(t.wikidata)].filter(
      Boolean,
    ),
  };
}

export const damSearchText = (n) =>
  `${n.meta.tags?.name || ''} ${n.meta.tags?.operator || ''} dam`;
