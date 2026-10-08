// Constellation satellite card: the satellite card plus its class and group.
// Uses satellite.js (via the satellites layer's format), like the satellites layer.

import { tleToNormalized, describeSatellite } from '../satellites/format.js';
import { satelliteClassLabel } from '../satellites/classes.js';
import { mergeGroups } from './groups.js';

export const normalizeConstellations = (results) => mergeGroups(results, tleToNormalized);

export function describeConstellation(n, now = new Date()) {
  const card = describeSatellite(n, now);
  const klass = n.meta.classLabel ?? satelliteClassLabel(n.meta.group, { norad: n.id });
  return {
    ...card,
    rows: [['Class', klass], ['Constellation', n.meta.groupLabel], ...card.rows],
  };
}

export const constellationSearchText = (n) =>
  `${n.meta.name} ${n.id} ${n.meta.groupLabel} ${n.meta.classLabel ?? ''}`;
