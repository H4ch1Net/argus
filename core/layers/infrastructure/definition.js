import * as Cesium from 'cesium';
import { parseOverpass } from '../overpass/parse.js';
import { areaTooLarge } from '../overpass/client.js';
import {
  DATACENTER_MAX_DEG,
  INSTALLATION_MAX_DEG,
  describeDatacenter,
  describeInstallation,
  installationColorHex,
  infraSearchText,
} from './format.js';

// OSM-mapped infrastructure as viewport-fetched point layers, sharing the
// Overpass client with surveillance and landmarks: data centres (internet
// infrastructure) and mapped military installations. Facility locations only.

const zoomNote = (maxDeg) => (q) =>
  q.bbox && areaTooLarge(q.bbox, maxDeg) ? 'zoom in to load' : '';
const DC_COLOR = Cesium.Color.fromCssColorString('#80deea');

export const datacentersDefinition = {
  id: 'datacenters',
  fetch: { mode: 'viewport' },
  interpolate: false,
  maxEntities: 3000,
  normalize: (json) => parseOverpass(json),
  statusNote: zoomNote(DATACENTER_MAX_DEG),
  render: { renderType: 'point', style: () => ({ pixelSize: 8, color: DC_COLOR }) },
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
    style: (n) => ({
      pixelSize: 8,
      color: Cesium.Color.fromCssColorString(installationColorHex(n.meta.tags)),
    }),
  },
  describe: (n) => describeInstallation(n),
  searchText: infraSearchText,
};
