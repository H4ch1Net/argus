import { layerInk } from '../sdk/colors.js';
import { parseOverpass } from '../overpass/parse.js';
import { areaTooLarge } from '../overpass/client.js';
import { DAM_MAX_DEG, describeDam, damSearchText } from './format.js';

// Dams mapped in OpenStreetMap as a viewport-fetched point layer over the
// shared Overpass client (same pattern as the data-centre layer). Facility
// locations only.

export const damsDefinition = {
  id: 'dams',
  fetch: { mode: 'viewport' },
  interpolate: false,
  maxEntities: 3000,
  normalize: (json) => parseOverpass(json),
  statusNote: (q, raw) =>
    q.bbox && areaTooLarge(q.bbox, DAM_MAX_DEG) && !raw?.elements?.length
      ? 'zoom in to load'
      : '',
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'triangle', pixelSize: 11, color: layerInk('dams') }),
  },
  describe: (n) => describeDam(n),
  searchText: damSearchText,
};
