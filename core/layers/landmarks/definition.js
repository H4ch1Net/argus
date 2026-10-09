import { parseOverpass } from '../overpass/parse.js';
import { describeLandmark } from './format.js';
import { ink } from '../sdk/colors.js';

// Landmarks: OSM tourism / historic features as a static point layer, fetched
// once per half-degree tile and kept 12 h (core/layers/sdk/tileCache.js). Uses
// the same Overpass client as the surveillance layer.

export const landmarksDefinition = {
  id: 'landmarks',
  fetch: {
    mode: 'viewport',
    tileCache: { tileDeg: 0.5, ttlMs: 12 * 3_600_000, maxTiles: 32 },
  },
  interpolate: false,
  maxEntities: 4000,
  normalize: (json) => parseOverpass(json),
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'frame', pixelSize: 10, color: ink('dimmer', 0.9) }),
  },
  describe: (n) => describeLandmark(n),
  searchText: (n) => n.meta.tags.name || '',
};
