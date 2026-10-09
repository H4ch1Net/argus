import { normalizeLandmarks } from './parse.js';
import { describeLandmark, landmarkSearchText } from './format.js';
import { tiledNote } from '../overpass/tiles.js';
import { ink } from '../sdk/colors.js';

// Landmarks: named OSM attractions, museums, viewpoints, monuments, castles,
// towers and lighthouses (./parse.js) as a static point layer, fetched once
// per tile and kept for a day; the same tiles feed TOOLS > LANDMARKS (NEARBY).
// Those with a Wikipedia / Wikidata entry draw larger and brighter.

const STYLE = {
  notable: { glyph: 'frame', pixelSize: 12, color: ink('white', 0.95) },
  other: { glyph: 'frame', pixelSize: 9, color: ink('dimmer', 0.8) },
};

export const landmarksDefinition = {
  id: 'landmarks',
  // Tiled and kept by the source (./parse.js createLandmarksSource), shared
  // with TOOLS > LANDMARKS; RELOAD reaches it as query.reload.
  fetch: { mode: 'viewport' },
  statusNote: (_q, raw) => tiledNote(raw),
  interpolate: false,
  maxEntities: 4000,
  normalize: (raw) => normalizeLandmarks(raw),
  render: {
    renderType: 'point',
    style: (n) => (n.meta.notable ? STYLE.notable : STYLE.other),
  },
  describe: (n) => describeLandmark(n),
  searchText: (n) => landmarkSearchText(n),
};
