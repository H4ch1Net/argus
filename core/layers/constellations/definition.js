import * as Cesium from 'cesium';
import { satPositionAt } from '../satellites/propagate.js';
import { groupInfo } from './groups.js';
import {
  normalizeConstellations,
  describeConstellation,
  constellationSearchText,
} from './format.js';

// Navigation (GPS, Galileo, GLONASS) and geostationary satellites as one
// compute-position layer: SGP4 from CelesTrak TLEs, coloured by constellation.
// Unlike the stations layer there are no orbit rings (hundreds would be noise),
// and positions are recomputed once a second rather than every frame: these
// orbits are slow on screen, and it keeps ~700 propagations cheap on a phone.

const colors = new Map();
const groupColor = (group) => {
  if (!colors.has(group))
    colors.set(group, Cesium.Color.fromCssColorString(groupInfo(group).color));
  return colors.get(group);
};

export const constellationsDefinition = {
  id: 'constellations',
  fetch: { mode: 'poll', intervalMs: 6 * 60 * 60 * 1000, viewportBounded: false },
  positionAt: (n, timeMs) => satPositionAt(n.meta.satrec, new Date(timeMs)),
  positionCacheMs: 1000,
  maxEntities: 1200,
  normalize: (results) => normalizeConstellations(results),
  render: {
    renderType: 'point',
    style: (n) => ({ pixelSize: 5, color: groupColor(n.meta.group) }),
  },
  describe: (n) => describeConstellation(n),
  searchText: constellationSearchText,
};
