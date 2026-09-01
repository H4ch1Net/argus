import * as Cesium from 'cesium';
import { parseOverpass } from '../overpass/parse.js';
import { describeLandmark } from './format.js';

// Landmarks: OSM tourism / historic features as a viewport-fetched, static point
// layer. Uses the same Overpass client as the surveillance layer.

export const landmarksDefinition = {
  id: 'landmarks',
  fetch: { mode: 'viewport' },
  interpolate: false,
  maxEntities: 4000,
  normalize: (json) => parseOverpass(json),
  render: {
    renderType: 'point',
    style: () => ({
      pixelSize: 6,
      color: Cesium.Color.fromCssColorString('#c6a3ff').withAlpha(0.9),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.45),
    }),
  },
  describe: (n) => describeLandmark(n),
  searchText: (n) => n.meta.tags.name || '',
};
