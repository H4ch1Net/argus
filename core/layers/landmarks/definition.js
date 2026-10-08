import { parseOverpass } from '../overpass/parse.js';
import { areaTooLarge } from '../overpass/client.js';
import { describeLandmark } from './format.js';
import { ink } from '../sdk/colors.js';

// Landmarks: OSM tourism / historic features as a viewport-fetched, static point
// layer. Uses the same Overpass client as the surveillance layer.

export const landmarksDefinition = {
  id: 'landmarks',
  fetch: { mode: 'viewport' },
  // The Overpass client skips views wider than a few degrees; say so.
  statusNote: (q, raw) =>
    q.bbox && areaTooLarge(q.bbox, 3) && !raw?.elements?.length ? 'zoom in to load' : '',
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
