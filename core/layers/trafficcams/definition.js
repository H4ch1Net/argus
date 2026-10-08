import {
  parseTrafficCams,
  trafficCamNote,
  describeTrafficCam,
  trafficCamSearchText,
} from './format.js';
import { ink } from '../sdk/colors.js';
import { trafficCamKindFilter, kindsPass } from './kinds.js';

// Public traffic cameras (Caltrans, TfL JamCams, Statens vegvesen, and the
// other DOT networks in ./sources.js) as a viewport-bounded point layer.
// Catalogues refresh every 15 minutes; a camera's still is fetched through the
// proxy only when its card is opened.
//
// The kind filter (./kinds.js trafficCamKindFilter: ramp, bridge, tunnel,
// pass, border, road), set by the filter chips or setKinds, is applied when
// the fetched cameras are drawn: after a change, layer.refresh() re-draws from
// the source's short memo, with no new request.
//
// GUARDRAIL: display only. No computer vision of any kind runs on the stills.

export const trafficCamsDefinition = {
  id: 'trafficcams',
  fetch: { mode: 'poll', intervalMs: 15 * 60 * 1000, viewportBounded: true },
  interpolate: false,
  maxEntities: 4000,
  normalize: (raw) =>
    parseTrafficCams(raw).filter((n) => kindsPass(n.meta.kinds, trafficCamKindFilter)),
  statusNote: (_q, raw) => trafficCamNote(raw, trafficCamKindFilter),
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'bracket', pixelSize: 12, color: ink('teal') }),
  },
  describe: (n) => describeTrafficCam(n),
  searchText: trafficCamSearchText,
  /** Show only cameras of these kinds (ids from CAMERA_KINDS); then refresh. */
  setKinds(ids) {
    trafficCamKindFilter.set(ids);
  },
  kindFilter: trafficCamKindFilter,
};
