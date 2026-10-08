// OSM-mapped infrastructure: data centres and military installations. Both are
// facility LOCATIONS as mapped by OpenStreetMap contributors (ODbL), read through
// the shared Overpass client. Pure: filters, styling and cards.

/** Overpass selectors (bbox appended by the client). */
export const DATACENTER_FILTERS = [
  'nwr["telecom"="data_center"]',
  'nwr["building"="data_center"]',
];
export const INSTALLATION_FILTERS = [
  'nwr["military"~"^(airfield|naval_base|range|barracks|base)$"]',
  'nwr["landuse"="military"]',
];
/** Widest view (degrees) each layer queries; Overpass is slow on big boxes. */
export const DATACENTER_MAX_DEG = 6;
export const INSTALLATION_MAX_DEG = 3;

const https = (v) => {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

const osmLink = (n) =>
  n.meta.osmType && n.meta.osmId != null
    ? {
        label: 'View on OpenStreetMap',
        url: `https://www.openstreetmap.org/${n.meta.osmType}/${n.meta.osmId}`,
      }
    : null;

const coords = (n) =>
  `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`;

function address(tags) {
  const street = [tags['addr:housenumber'], tags['addr:street']]
    .filter(Boolean)
    .join(' ');
  return (
    [street, tags['addr:city'], tags['addr:country']].filter(Boolean).join(', ') || null
  );
}

export function describeDatacenter(n) {
  const t = n.meta.tags;
  const name = t.name || t['name:en'] || t.official_name;
  const site = https(t.website);
  return {
    id: n.id,
    title: name || 'Data centre',
    subtitle: t.operator || t['operator:short'] || '',
    rows: [
      ['Operator', t.operator || '—'],
      ['Address', address(t) || '—'],
      ['IT load', t['capacity:it_load'] || t.it_load || '—'],
      ['Coordinates', coords(n)],
      ['Source', 'OpenStreetMap contributors (ODbL)'],
    ],
    links: [osmLink(n), site ? { label: 'Website', url: site } : null].filter(Boolean),
  };
}

export function installationKind(tags) {
  return (
    tags.military || (tags.landuse === 'military' ? 'military area' : 'installation')
  );
}

export function installationColorHex(tags) {
  const k = installationKind(tags);
  if (k === 'airfield') return '#90caf9';
  if (k === 'naval_base') return '#4dd0e1';
  if (k === 'range') return '#ffab91';
  return '#a5d6a7';
}

export function describeInstallation(n) {
  const t = n.meta.tags;
  const kind = installationKind(t).replace(/_/g, ' ');
  return {
    id: n.id,
    title: t.name || t['name:en'] || kind,
    subtitle: t.operator || kind,
    rows: [
      ['Type', kind],
      ['Operator', t.operator || '—'],
      ['Coordinates', coords(n)],
      ['Source', 'OpenStreetMap contributors (ODbL)'],
    ],
    links: [osmLink(n)].filter(Boolean),
  };
}

export const infraSearchText = (n) =>
  `${n.meta.tags.name || ''} ${n.meta.tags.operator || ''} ${n.meta.tags.military || ''}`;
