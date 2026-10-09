// Surveillance-infrastructure styling + card. LOCATIONS ONLY (project guardrail):
// this maps WHERE cameras, ALPR readers, acoustic sensors, guard posts and
// speed / red-light cameras are, and which way they are mapped as facing, from
// OpenStreetMap (man_made=surveillance, highway=speed_camera, enforcement
// relations; DeFlock maps ALPR readers into OSM). It never reads what any
// device sees or hears.

import { cameraCones, describeFacing, directionTag } from './cones.js';
import { surveillanceKindOf, kindInfo, ENFORCEMENT_KINDS } from './kinds.js';
import { osmLink } from '../overpass/parse.js';

/** The kind id of a record or a tag set (see ./kinds.js). */
export function surveillanceKind(tagsOrRecord) {
  if (tagsOrRecord?.meta)
    return tagsOrRecord.meta.kind ?? surveillanceKindOf(tagsOrRecord.meta.tags);
  return surveillanceKindOf(tagsOrRecord || {});
}

// Terminal colours per kind (the globe draws them in the ctOS greys).
const TERM_HEX = {
  alpr: '#ff4d4d',
  acoustic: '#ff8a4d',
  redlight: '#ffd84d',
  speed: '#ffd84d',
  average: '#ffd84d',
  guard: '#c9c9c9',
};
export function surveillanceColorHex(kind) {
  return TERM_HEX[kind] ?? '#ffb454';
}

export function surveillancePixelSize(kind) {
  return kindInfo(kind).px;
}

const clip = (v, n = 40) => (v == null || v === '' ? null : String(v).slice(0, n));
const words = (v) => String(v).replace(/[_;]+/g, ' ').trim();

const SCOPE = {
  public: 'Public space',
  outdoor: 'Private, outdoor',
  indoor: 'Indoor',
  traffic: 'Traffic',
};
const ENFORCES = {
  maxspeed: 'Speed limit',
  average_speed: 'Average speed over a section',
  traffic_signals: 'Red light',
  mindistance: 'Distance to the vehicle ahead',
  noise: 'Noise',
  toll: 'Toll',
};

/** "50" -> "50 km/h", "30 mph" stays. */
function speedText(v) {
  const s = clip(v, 16);
  if (!s) return null;
  return /^\d+(\.\d+)?$/.test(s) ? `${s} km/h` : s;
}

function titleOf(kind, tags) {
  if (kind === 'alpr') return 'ALPR / plate reader';
  if (kind === 'acoustic')
    return /gunshot/i.test(tags['surveillance:type'] || '')
      ? 'Gunshot detector'
      : 'Acoustic sensor';
  return kindInfo(kind).label;
}

export function describeSurveillance(n) {
  const tags = n.meta.tags || {};
  const kind = surveillanceKind(n);
  const enf = n.meta.enforcement;
  const spec = cameraCones(n);
  const raw = directionTag(tags);
  // camera:angle is the tilt from the horizontal in OSM (not the view width).
  const tilt = clip(tags['camera:angle'], 12);
  const maker =
    tags.manufacturer ||
    tags['surveillance:manufacturer'] ||
    tags.brand ||
    tags['surveillance:brand'];
  const operator = tags.operator || tags['surveillance:operator'];
  const enforces = enf?.kind || tags.enforcement;
  const limit = speedText(tags.maxspeed || enf?.maxspeed);
  const rows = [['Type', kindInfo(kind).label]];
  const add = (label, value) => value && rows.push([label, String(value)]);
  add('Operator', clip(operator, 60));
  add('Maker', clip(maker, 40));
  add('Name', clip(tags.name || tags.ref, 50));
  add(
    'Scope',
    SCOPE[tags.surveillance] ?? clip(tags.surveillance && words(tags.surveillance), 24),
  );
  add('Zone', clip(tags['surveillance:zone'] && words(tags['surveillance:zone']), 40));
  add('Camera', clip(tags['camera:type'] && words(tags['camera:type']), 24));
  add('Mount', clip(tags['camera:mount'] && words(tags['camera:mount']), 24));
  if (ENFORCEMENT_KINDS.has(kind) || enforces) {
    add('Enforces', ENFORCES[enforces] ?? clip(enforces && words(enforces), 30));
    add('Limit', limit);
    add('Section', clip(enf?.name, 50));
  }
  if (spec) {
    rows.push(['Direction', describeFacing(spec)]);
    add('Tagged as', raw);
  }
  if (tilt) rows.push(['Tilt', /^\d+(\.\d+)?$/.test(tilt) ? `${tilt} deg` : tilt]);
  add('Height', clip(tags.height, 12));
  rows.push([
    'Source',
    kind === 'alpr' ? 'OpenStreetMap (DeFlock mapping)' : 'OpenStreetMap',
  ]);
  rows.push([
    'Coordinates',
    `${n.position.latitude.toFixed(5)}, ${n.position.longitude.toFixed(5)}`,
  ]);
  const link = osmLink(n);
  return {
    id: n.id,
    title: titleOf(kind, tags),
    subtitle: clip(operator || maker || '', 60) || '',
    rows,
    links: link ? [link] : [],
  };
}

/** The mapped facing for the terminal (degrees of the first cone), or null. */
export function surveillanceHeading(n) {
  const spec = cameraCones(n);
  return spec && !spec.ring ? spec.cones[0].headingDeg : null;
}

/** What global search matches: kind, operator, maker, name, ref. */
export function surveillanceSearchText(n) {
  const t = n.meta.tags || {};
  return [
    kindInfo(surveillanceKind(n)).label,
    t.operator,
    t.manufacturer,
    t.brand,
    t.name,
    t.ref,
    t['surveillance:type'],
    n.meta.enforcement?.name,
  ]
    .filter(Boolean)
    .join(' ');
}
