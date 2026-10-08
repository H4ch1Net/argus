// Satellite classes: CelesTrak source group -> a class people can read
// (STATION, NAV, GEO, VISUAL, COMMS), with one colour per class and a legend.
// Adapted from gods-eye-view src/data/satelliteClass.js (MIT).
//
// Classification is a pure lookup on the group a satellite was loaded from: no
// extra fetch, no heuristics, no per-frame work. The point colour, the card's
// class label and the legend swatch all read this table, so they cannot drift
// apart. Colours are ctOS palette inks (core/ui/palette.js), no new hues: green
// and red stay reserved for state. Pure, no Cesium: shared with the terminal.

import { INK } from '../../ui/palette.js';

/**
 * Class registry, in legend order: crewed first (what people look for), then
 * the constellations people can name, then the catch-all, then the dense shell.
 * @type {Readonly<Record<string, { label: string, color: string, blurb: string }>>}
 */
export const SATELLITE_CLASSES = Object.freeze({
  station: Object.freeze({
    label: 'STATION',
    color: INK.white, // the brightest objects in the sky, drawn brightest
    blurb: 'Crewed stations and their visiting vehicles',
  }),
  nav: Object.freeze({
    label: 'NAV',
    color: INK.cyan, // the strongest accent for the class people name most
    blurb: 'Navigation: GPS, Galileo, GLONASS',
  }),
  geo: Object.freeze({
    label: 'GEO',
    color: INK.mint,
    blurb: 'Geostationary belt: comms and weather, fixed over the equator',
  }),
  visual: Object.freeze({
    label: 'VISUAL',
    color: INK.dimmer, // the catch-all recedes behind the classes that mean something
    blurb: 'Brightest naked-eye objects (CelesTrak visual group)',
  }),
  comms: Object.freeze({
    label: 'COMMS',
    color: INK.slate, // thousands in dense mode: texture, never competing
    blurb: 'Broadband constellation shell (Starlink), dense mode only',
  }),
});

export const SATELLITE_CLASS_ORDER = Object.freeze([
  'station',
  'nav',
  'geo',
  'visual',
  'comms',
]);

/** Every class as a legend row, in order (for a static legend). */
export const SATELLITE_CLASS_LEGEND = Object.freeze(
  SATELLITE_CLASS_ORDER.map((klass) =>
    Object.freeze({ klass, ...SATELLITE_CLASSES[klass] }),
  ),
);

// CelesTrak GROUP name -> class and the constellation subtype shown beside it.
const GROUP_CLASS = Object.freeze({
  stations: { klass: 'station', subtype: null },
  visual: { klass: 'visual', subtype: null },
  'gps-ops': { klass: 'nav', subtype: 'GPS' },
  galileo: { klass: 'nav', subtype: 'Galileo' },
  'glo-ops': { klass: 'nav', subtype: 'GLONASS' },
  geo: { klass: 'geo', subtype: null },
  starlink: { klass: 'comms', subtype: 'Starlink' },
});

/**
 * Crewed stations by NORAD id. CelesTrak lists the ISS in `visual` as well as
 * `stations`, so it is a STATION whichever group loaded it.
 */
export const STATION_NORAD = Object.freeze({ 25544: 'ISS', 48274: 'Tiangong' });

const FALLBACK = Object.freeze({ klass: 'visual', subtype: null });

/**
 * @param {string|null|undefined} group CelesTrak group name
 * @param {{ norad?: string|number }} [opts]
 * @returns {{ klass: string, subtype: string|null }}
 */
export function satelliteClassOf(group, { norad } = {}) {
  const station = norad != null ? STATION_NORAD[String(norad)] : undefined;
  if (station) return { klass: 'station', subtype: station };
  return GROUP_CLASS[group] ?? FALLBACK;
}

/** Point colour (CSS string) for a group. */
export const satelliteClassColor = (group, opts) =>
  SATELLITE_CLASSES[satelliteClassOf(group, opts).klass].color;

/** Card label: "NAV · GPS", "GEO", "STATION · ISS". */
export function satelliteClassLabel(group, opts) {
  const { klass, subtype } = satelliteClassOf(group, opts);
  const base = SATELLITE_CLASSES[klass].label;
  return subtype ? `${base} · ${subtype}` : base;
}

/**
 * Count satellites per class. Entries are group names or { group, norad }.
 * @returns {Record<string, number>}
 */
export function tallySatelliteClasses(entries) {
  const counts = {};
  for (const e of entries || []) {
    const d = e && typeof e === 'object' ? e : { group: e };
    const { klass } = satelliteClassOf(d.group, { norad: d.norad });
    counts[klass] = (counts[klass] || 0) + 1;
  }
  return counts;
}

/**
 * Legend rows for the classes present, in order (a class with no satellites is
 * left out, so COMMS appears only once dense mode is on).
 * @param {Record<string, number>} counts
 * @returns {{ klass: string, label: string, color: string, blurb: string, count: number }[]}
 */
export function satelliteClassLegend(counts) {
  return SATELLITE_CLASS_LEGEND.filter((row) => counts?.[row.klass] > 0).map((row) => ({
    ...row,
    count: counts[row.klass],
  }));
}
