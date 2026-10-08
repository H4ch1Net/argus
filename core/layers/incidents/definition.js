import { ink } from '../sdk/colors.js';
import { groundDecorations } from '../surveillance/groundBatch.js';
import { parseTomTomIncidents } from './parse.js';
import {
  describeIncident,
  incidentGlyph,
  incidentInkName,
  incidentPixelSize,
  incidentSearchText,
} from './format.js';

// Traffic incidents (TomTom Incident Details v5) as a Layer SDK point layer:
// one glyph per incident by kind, red only when critical. The affected stretch
// of road, when TomTom gives one, is drawn on the ground as a line; all of the
// layer's lines are one batched ground primitive rebuilt when the incident set
// changes (core/layers/surveillance/groundBatch.js), never per frame. Polled
// every 5 minutes for the view (at most an 80 km square, the API's area
// limit), and after the camera settles at most every 5 s; the proxy caches
// answers 2 minutes and caps the day under TomTom's free allowance. Needs
// TOMTOM_API_KEY on the proxy: register it with `requires: 'tomtom-incidents'`.

const roads = groundDecorations({
  // Lines stay visible at any zoom the view is fetched for.
  scaleFor: (h) => (h > 400_000 ? 0 : 1),
  collect: (records) => {
    const lines = [];
    for (const n of records.values()) {
      const path = n.meta.path;
      if (!path || path.length < 2) continue;
      lines.push({
        path: path.flat(),
        color: ink(incidentInkName(n.meta.severity), 0.8),
        width: n.meta.severity === 'critical' ? 4 : 3,
      });
    }
    return { fills: [], lines };
  },
});

export const incidentsDefinition = {
  id: 'incidents',
  fetch: { mode: 'poll', intervalMs: 5 * 60_000, viewportBounded: true },
  interpolate: false,
  maxEntities: 2000,
  normalize: (raw) => parseTomTomIncidents(raw?.json ?? raw),
  statusNote: (_q, raw) =>
    raw?.clipped ? 'nearest 80 km' : raw && !raw.json?.incidents?.length ? 'none here' : '',
  render: {
    renderType: 'point',
    style: (n) => ({
      glyph: incidentGlyph(n.meta.kind),
      pixelSize: incidentPixelSize(n.meta.severity),
      color: ink(incidentInkName(n.meta.severity)),
    }),
  },
  onEntityCreate: roads.onEntityCreate,
  onShow: roads.onShow,
  describe: (n) => describeIncident(n),
  searchText: incidentSearchText,
};
