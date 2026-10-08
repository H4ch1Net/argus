import {
  parseWebcams,
  filterWebcams,
  webcamNote,
  describeWebcam,
  webcamSearchText,
} from './format.js';
import { webcamFilter, categoryInfo } from './categories.js';
import { layerInk } from '../sdk/colors.js';

// Public webcams (Windy, NPS, NASA EPIC, observatory stills) as a
// viewport-bounded point layer, one ctOS glyph per category. Listings refresh
// every 5 minutes (Windy's still links expire after about 10); a still is
// fetched through the proxy only when its card is opened.
//
// The category filter (./categories.js webcamFilter, set by the filter chips
// or setCategories) is applied when the fetched data is drawn: after a change,
// layer.refresh() re-draws from the source's memo, with no new request.
//
// GUARDRAIL: display only. No computer vision of any kind runs on the stills.

export const webcamsDefinition = {
  id: 'webcams',
  fetch: { mode: 'poll', intervalMs: 5 * 60 * 1000, viewportBounded: true },
  interpolate: false,
  maxEntities: 1500,
  normalize: (raw) => filterWebcams(parseWebcams(raw), webcamFilter),
  statusNote: (_q, raw) => webcamNote(raw, webcamFilter),
  render: {
    renderType: 'point',
    style: (n) => ({
      glyph: categoryInfo(n.meta.category).glyph,
      pixelSize: 13,
      color: layerInk('webcams'),
    }),
  },
  describe: (n) => describeWebcam(n),
  searchText: webcamSearchText,
  /** Show only these categories (ids from WEBCAM_CATEGORIES); then refresh. */
  setCategories(ids) {
    webcamFilter.set(ids);
  },
  filter: webcamFilter,
};
