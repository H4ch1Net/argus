import { satPositionAt } from '../satellites/propagate.js';
import { cesiumColor } from '../sdk/colors.js';
import { satelliteClassColor } from '../satellites/classes.js';
import { createRoundRobinPositioner } from './roundRobin.js';
import {
  normalizeConstellations,
  describeConstellation,
  constellationSearchText,
} from './format.js';

// Navigation, geostationary and the brightest ("visual") satellites as one
// compute-position layer: SGP4 from CelesTrak TLEs, coloured by satellite class
// (satellites/classes.js). Optional dense mode adds the Starlink shell as small
// points (the source's `dense` flag; desktop tier only, never on a phone).
// Unlike the stations layer there are no orbit rings (hundreds would be noise).
// Propagation is round-robin: each satellite is re-propagated once a second (5 s
// in the dense shell) at its own phase and extrapolated in between, so the SGP4
// work is spread evenly over frames instead of all landing in one.

const CORE_PERIOD_MS = 1000;
const DENSE_PERIOD_MS = 5000;

const classColor = (n) => cesiumColor(satelliteClassColor(n.meta.group, { norad: n.id }));

export const constellationsDefinition = {
  id: 'constellations',
  fetch: { mode: 'poll', intervalMs: 6 * 60 * 60 * 1000, viewportBounded: false },
  positionAt: createRoundRobinPositioner(
    (n, timeMs) => satPositionAt(n.meta.satrec, new Date(timeMs)),
    { periodFor: (n) => (n.meta.dense ? DENSE_PERIOD_MS : CORE_PERIOD_MS) },
  ),
  // Room for the dense shell (~10k Starlink) on top of the ~850 core satellites;
  // the core groups come first, so a cap never drops them.
  maxEntities: 14000,
  normalize: (results) => normalizeConstellations(results),
  render: {
    renderType: 'point',
    style: (n) =>
      n.meta.dense
        ? { glyph: 'square', pixelSize: 3, color: classColor(n) }
        : { pixelSize: 5, color: classColor(n) },
  },
  describe: (n) => describeConstellation(n),
  searchText: constellationSearchText,
};
