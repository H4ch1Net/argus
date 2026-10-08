import { parseOverpass } from '../overpass/parse.js';
import { areaTooLarge } from '../overpass/client.js';
import {
  DATACENTER_MAX_DEG,
  INSTALLATION_MAX_DEG,
  describeDatacenter,
  describeInstallation,
  infraSearchText,
} from './format.js';
import { ink } from '../sdk/colors.js';

// OSM-mapped infrastructure as viewport-fetched point layers, sharing the
// Overpass client with surveillance and landmarks: data centres (internet
// infrastructure) and mapped military installations. Facility locations only.

const zoomNote = (maxDeg) => (q, raw) =>
  q.bbox && areaTooLarge(q.bbox, maxDeg) && !raw?.elements?.length
    ? 'zoom in to load'
    : '';

export const datacentersDefinition = {
  id: 'datacenters',
  fetch: { mode: 'viewport' },
  interpolate: false,
  maxEntities: 3000,
  normalize: (json) => parseOverpass(json),
  statusNote: zoomNote(DATACENTER_MAX_DEG),
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'frame', pixelSize: 11, color: ink('cyan') }),
  },
  describe: (n) => describeDatacenter(n),
  searchText: infraSearchText,
};

export const installationsDefinition = {
  id: 'installations',
  fetch: { mode: 'viewport' },
  interpolate: false,
  maxEntities: 3000,
  normalize: (json) => parseOverpass(json),
  statusNote: zoomNote(INSTALLATION_MAX_DEG),
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'diamond', pixelSize: 12, color: ink('mint', 0.9) }),
  },
  describe: (n) => describeInstallation(n),
  searchText: infraSearchText,
};
