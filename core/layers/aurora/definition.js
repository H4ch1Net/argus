import { createCanvasImagery, pixelsToCanvas } from './canvasImagery.js';
import { auroraNote, auroraPixels, sampleOvation } from './parse.js';

// Aurora as a Layer SDK 'field' layer: the NOAA SWPC OVATION nowcast (a 1
// degree global grid of the probability of visible aurora) drawn as one
// translucent mint texture over the poles, with the planetary K index in the
// status note. Global data, so one fetch serves every view: refreshed every 10
// minutes (SWPC updates it about every 5; the proxy caches it), never on a
// pan. sample(lon, lat) gives the probability and Kp for a readout.

const WIDTH = 360;
const HEIGHT = 180;

export const auroraDefinition = {
  id: 'aurora',
  fetch: { mode: 'viewport', intervalMs: 10 * 60_000 },
  fieldKey: () => 'global',
  normalize: (raw) => {
    const grid = raw?.grid ?? null;
    if (!grid) return null;
    // The count beside the layer: grid cells where aurora is likely (>= 10 %).
    let likely = 0;
    for (const v of grid.values) if (v >= 10) likely += 1;
    return { ...grid, kp: raw.kp ?? null, count: likely };
  },
  sample: (field, lon, lat) => ({
    probability: sampleOvation(field, lon, lat),
    kp: field.kp?.kp ?? null,
  }),
  statusNote: (_q, field) => auroraNote(field),
  render: {
    renderType: 'field',
    create: (viewer) => {
      const overlay = createCanvasImagery(viewer, {
        alpha: 0.85,
        credit: 'Aurora: NOAA SWPC OVATION',
      });
      return {
        setField(field) {
          if (!field) return;
          const canvas = pixelsToCanvas(auroraPixels(field, WIDTH, HEIGHT), WIDTH, HEIGHT);
          overlay.show(canvas, [-180, -90, 180, 90]);
        },
        setVisible: (on) => overlay.setVisible(on),
        destroy: () => overlay.destroy(),
      };
    },
  },
};
