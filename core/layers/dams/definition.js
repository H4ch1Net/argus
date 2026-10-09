import { layerInk } from '../sdk/colors.js';
import { parseOverpass } from '../overpass/parse.js';
import { describeDam, damSearchText } from './format.js';

// Dams mapped in OpenStreetMap as a static point layer over the shared Overpass
// client (same pattern as the data-centre layer). Facility locations only.
// Fetched once per one-degree tile and kept a day, or until RELOAD
// (core/layers/sdk/tileCache.js).

export const damsDefinition = {
  id: 'dams',
  fetch: {
    mode: 'viewport',
    tileCache: { tileDeg: 1, ttlMs: 24 * 3_600_000, maxTiles: 32 },
  },
  interpolate: false,
  maxEntities: 3000,
  normalize: (json) => parseOverpass(json),
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'triangle', pixelSize: 11, color: layerInk('dams') }),
  },
  describe: (n) => describeDam(n),
  searchText: damSearchText,
};
