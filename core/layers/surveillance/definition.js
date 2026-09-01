import * as Cesium from 'cesium';
import { parseOverpass } from '../overpass/parse.js';
import {
  surveillanceKind,
  surveillanceColorHex,
  surveillancePixelSize,
  describeSurveillance,
} from './format.js';

// The "eyes": surveillance-infrastructure locations from OSM (man_made=surveillance),
// including ALPR/Flock readers. A viewport-fetched, static point layer. GUARDRAIL:
// locations only, never a reading of what the equipment sees. ALPR readers are
// drawn distinctly (red) from ordinary cameras (amber).

export const surveillanceDefinition = {
  id: 'surveillance',
  fetch: { mode: 'viewport' },
  interpolate: false,
  maxEntities: 4000,
  normalize: (json) => parseOverpass(json),
  render: {
    renderType: 'point',
    style: (n) => {
      const kind = surveillanceKind(n.meta.tags);
      return {
        pixelSize: surveillancePixelSize(kind),
        color: Cesium.Color.fromCssColorString(surveillanceColorHex(kind)).withAlpha(0.9),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
      };
    },
  },
  describe: (n) => describeSurveillance(n),
  searchText: (n) =>
    `${n.meta.tags.operator || ''} ${n.meta.tags['surveillance:type'] || ''} ${n.meta.tags.man_made || ''}`,
};
