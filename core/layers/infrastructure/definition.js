import { parseOverpass } from '../overpass/parse.js';
import { describeDatacenter, describeInstallation, infraSearchText } from './format.js';
import { ink } from '../sdk/colors.js';

// OSM-mapped infrastructure as static point layers, sharing the Overpass client
// with surveillance and landmarks: data centres (internet infrastructure) and
// mapped military installations. Facility locations only. Fetched once per
// tile and kept a day, or until RELOAD (core/layers/sdk/tileCache.js): the
// tiles are as big as the client allows, since both are sparse.

const DAY_MS = 24 * 3_600_000;

export const datacentersDefinition = {
  id: 'datacenters',
  fetch: { mode: 'viewport', tileCache: { tileDeg: 2, ttlMs: DAY_MS, maxTiles: 32 } },
  interpolate: false,
  maxEntities: 3000,
  normalize: (json) => parseOverpass(json),
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'frame', pixelSize: 11, color: ink('cyan') }),
  },
  describe: (n) => describeDatacenter(n),
  searchText: infraSearchText,
};

export const installationsDefinition = {
  id: 'installations',
  fetch: { mode: 'viewport', tileCache: { tileDeg: 1, ttlMs: DAY_MS, maxTiles: 32 } },
  interpolate: false,
  maxEntities: 3000,
  normalize: (json) => parseOverpass(json),
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'diamond', pixelSize: 12, color: ink('mint', 0.9) }),
  },
  describe: (n) => describeInstallation(n),
  searchText: infraSearchText,
};
