// Landmark card and labels, from OSM tourism / historic / man_made tags. Pure.

import { osmLink } from '../overpass/parse.js';
import { landmarkCategory } from './parse.js';

export { landmarkCategory };

const LABELS = {
  attraction: 'Attraction',
  museum: 'Museum',
  viewpoint: 'Viewpoint',
  zoo: 'Zoo',
  theme_park: 'Theme park',
  aquarium: 'Aquarium',
  monument: 'Monument',
  castle: 'Castle',
  memorial: 'Memorial',
  monastery: 'Monastery',
  fort: 'Fort',
  palace: 'Palace',
  city_gate: 'City gate',
  ruins: 'Ruins',
  archaeological_site: 'Archaeological site',
  tower: 'Tower',
  lighthouse: 'Lighthouse',
};

// Short codes for list rows (TOOLS > LANDMARKS).
const CODES = {
  attraction: 'SIGHT',
  museum: 'MUSEUM',
  viewpoint: 'VIEW',
  zoo: 'ZOO',
  theme_park: 'PARK',
  aquarium: 'AQUARIUM',
  monument: 'MONUMENT',
  castle: 'CASTLE',
  memorial: 'MEMORIAL',
  monastery: 'ABBEY',
  fort: 'FORT',
  palace: 'PALACE',
  city_gate: 'GATE',
  ruins: 'RUINS',
  archaeological_site: 'SITE',
  tower: 'TOWER',
  lighthouse: 'LIGHT',
};
/** A short upper-case code for a category ("monastery" -> "ABBEY"). */
export const categoryCode = (id) =>
  CODES[id] ??
  String(id || 'SIGHT')
    .slice(0, 8)
    .toUpperCase();

/** "archaeological_site" -> "Archaeological site". */
export function categoryLabel(id) {
  if (LABELS[id]) return LABELS[id];
  const s = String(id || 'feature').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A wikipedia tag ("fr:Musée de l'Armée") as a link, or null. */
export function wikipediaLink(value) {
  const m = /^([a-z]{2,3}(?:-[a-z]+)?):(.+)$/i.exec(String(value || '').trim());
  if (!m) return null;
  const title = m[2].trim().replace(/ /g, '_');
  return {
    label: `Wikipedia (${m[1].toLowerCase()})`,
    url: `https://${m[1].toLowerCase()}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  };
}

export function describeLandmark(n) {
  const tags = n.meta.tags || {};
  const category = n.meta.category ?? landmarkCategory(tags);
  const name = n.meta.name || tags.name || categoryLabel(category);
  const rows = [['Category', categoryLabel(category)]];
  const add = (label, value) => value && rows.push([label, String(value).slice(0, 60)]);
  if (tags['name:en'] && tags['name:en'] !== name) add('English', tags['name:en']);
  add('Built', tags.start_date);
  add(
    'Height',
    /^\d+(\.\d+)?$/.test(tags.height || '') ? `${tags.height} m` : tags.height,
  );
  add('Heritage', tags.heritage ? `listed (level ${tags.heritage})` : null);
  add('Operator', tags.operator);
  add('Open', tags.opening_hours);
  add('Fee', tags.fee === 'no' ? 'free' : tags.fee === 'yes' ? 'paid' : null);
  rows.push([
    'Coordinates',
    `${n.position.latitude.toFixed(5)}, ${n.position.longitude.toFixed(5)}`,
  ]);
  const links = [];
  const wiki = wikipediaLink(tags.wikipedia);
  if (wiki) links.push(wiki);
  if (/^Q\d+$/.test(tags.wikidata || ''))
    links.push({
      label: 'Wikidata',
      url: `https://www.wikidata.org/wiki/${tags.wikidata}`,
    });
  const site = tags.website || tags['contact:website'];
  if (/^https?:\/\//i.test(site || '')) links.push({ label: 'Website', url: site });
  const osm = osmLink(n);
  if (osm) links.push(osm);
  return {
    id: n.id,
    title: name,
    subtitle: categoryLabel(category),
    rows,
    links,
  };
}

export function landmarkSearchText(n) {
  const t = n.meta.tags || {};
  return `${n.meta.name || t.name || ''} ${t['name:en'] || ''} ${categoryLabel(n.meta.category)}`;
}
