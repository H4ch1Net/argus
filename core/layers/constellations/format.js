// Constellation satellite card: the satellite card plus its constellation.
// Uses satellite.js (via the satellites layer's format), like the satellites layer.

import { tleToNormalized, describeSatellite } from '../satellites/format.js';
import { mergeGroups } from './groups.js';

export const normalizeConstellations = (results) => mergeGroups(results, tleToNormalized);

export function describeConstellation(n, now = new Date()) {
  const card = describeSatellite(n, now);
  return { ...card, rows: [['Constellation', n.meta.groupLabel], ...card.rows] };
}

export const constellationSearchText = (n) =>
  `${n.meta.name} ${n.id} ${n.meta.groupLabel}`;
