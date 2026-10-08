import * as Cesium from 'cesium';
import {
  parseTrafficCams,
  trafficCamNote,
  describeTrafficCam,
  trafficCamSearchText,
} from './format.js';

// Public traffic cameras (Caltrans, TfL JamCams, Statens vegvesen) as a
// viewport-bounded point layer. Catalogues refresh every 15 minutes; a camera's
// still is fetched through the proxy only when its card is opened.
// GUARDRAIL: display only. No computer vision of any kind runs on the stills.

const CAM_COLOR = Cesium.Color.fromCssColorString('#5fe3ff');

export const trafficCamsDefinition = {
  id: 'trafficcams',
  fetch: { mode: 'poll', intervalMs: 15 * 60 * 1000, viewportBounded: true },
  interpolate: false,
  maxEntities: 4000,
  normalize: (raw) => parseTrafficCams(raw),
  statusNote: (_q, raw) => trafficCamNote(raw),
  render: { renderType: 'point', style: () => ({ pixelSize: 7, color: CAM_COLOR }) },
  describe: (n) => describeTrafficCam(n),
  searchText: trafficCamSearchText,
};
