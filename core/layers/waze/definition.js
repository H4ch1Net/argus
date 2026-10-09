import { ink } from '../sdk/colors.js';
import { groundDecorations } from '../surveillance/groundBatch.js';
import { parseWaze } from './parse.js';
import {
  describeWaze,
  wazeGlyph,
  wazeInkName,
  wazePixelSize,
  wazeSearchText,
} from './format.js';

// Waze alerts and jams (./parse.js) as a Layer SDK point layer: one glyph per
// alert by kind (a shield for police reports), red only when critical; each
// jam's stretch of road on the ground, all of them one batched ground
// primitive rebuilt when the set changes, never per frame. Polled every 2
// minutes for the view (at most the 1 degree square around its centre), and
// after the camera settles; the proxy caches answers a minute and caps the
// rate. Off by default (personal use, unofficial endpoint).

const roads = groundDecorations({
  scaleFor: (h) => (h > 300_000 ? 0 : 1),
  collect: (records) => {
    const lines = [];
    for (const n of records.values()) {
      const path = n.meta.path;
      if (!path || path.length < 2) continue;
      lines.push({
        path: path.flat(),
        color: ink(wazeInkName(n.meta.severity), 0.75),
        width: n.meta.severity === 'critical' ? 4 : 3,
      });
    }
    return { fills: [], lines };
  },
});

export const wazeDefinition = {
  id: 'waze',
  fetch: { mode: 'poll', intervalMs: 2 * 60_000, viewportBounded: true },
  interpolate: false,
  maxEntities: 1500,
  normalize: (raw) => parseWaze(raw?.json ?? raw),
  statusNote: (_q, raw) =>
    raw?.note ||
    [
      raw?.via === 'local' ? 'your waze-server' : raw?.via === 'demo' ? 'DEMO' : '',
      raw?.clipped ? 'nearest 100 km' : '',
      raw && !raw.json?.alerts?.length && !raw.json?.jams?.length ? 'none here' : '',
    ]
      .filter(Boolean)
      .join(' · '),
  render: {
    renderType: 'point',
    style: (n) => ({
      glyph: wazeGlyph(n.meta.kind),
      pixelSize: wazePixelSize(n.meta.severity),
      color: ink(wazeInkName(n.meta.severity)),
    }),
  },
  onEntityCreate: roads.onEntityCreate,
  onShow: roads.onShow,
  describe: (n) => describeWaze(n),
  searchText: wazeSearchText,
};
