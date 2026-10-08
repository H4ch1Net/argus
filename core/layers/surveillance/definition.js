import { parseOverpass } from '../overpass/parse.js';
import { areaTooLarge } from '../overpass/client.js';
import { surveillanceKind, describeSurveillance } from './format.js';
import { ink } from '../sdk/colors.js';

// The "eyes": surveillance-infrastructure locations from OSM (man_made=surveillance),
// including ALPR/Flock readers. A viewport-fetched, static point layer. GUARDRAIL:
// locations only, never a reading of what the equipment sees. ALPR readers are
// drawn distinctly (red) from ordinary cameras (amber).

export const surveillanceDefinition = {
  id: 'surveillance',
  fetch: { mode: 'viewport' },
  // The Overpass client skips views wider than a few degrees; say so.
  statusNote: (q, raw) =>
    q.bbox && areaTooLarge(q.bbox, 3) && !raw?.elements?.length ? 'zoom in to load' : '',
  interpolate: false,
  maxEntities: 4000,
  normalize: (json) => parseOverpass(json),
  render: {
    // Corner brackets: something that watches. ALPR readers slightly larger.
    renderType: 'point',
    style: (n) => {
      const kind = surveillanceKind(n.meta.tags);
      return {
        glyph: 'bracket',
        pixelSize: kind === 'ALPR' ? 14 : 11,
        color: kind === 'ALPR' ? ink('white') : ink('gray', 0.9),
      };
    },
  },
  describe: (n) => describeSurveillance(n),
  searchText: (n) =>
    `${n.meta.tags.operator || ''} ${n.meta.tags['surveillance:type'] || ''} ${n.meta.tags.man_made || ''}`,
};
