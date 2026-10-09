// The basemap worker: fetches, decodes and draws vector tiles off the main
// thread (OffscreenCanvas), and hands each finished tile back as a
// vertically flipped ImageBitmap (what Cesium expects of a bitmap), so panning
// and zooming never wait on tile drawing.
//
// Messages in:  { type: 'init', template }
//               { type: 'render', id, kind, z, x, y, size, pr }
// Messages out: { id, bitmap } | { id, empty: true } | { id, error }

import { createTileEngine } from './tiles.js';

let engine = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    engine = createTileEngine({
      template: m.template,
      makeCanvas: (w, h) => new OffscreenCanvas(w, h),
    });
    return;
  }
  if (m.type !== 'render') return;
  try {
    const canvas = await engine.render(m.kind, m.z, m.x, m.y, m.size, m.pr);
    if (!canvas) {
      self.postMessage({ id: m.id, empty: true });
      return;
    }
    // Cesium uploads an ImageBitmap as it is (WebGL ignores UNPACK_FLIP_Y for
    // bitmaps) and expects it pre-flipped, as its own image loader makes them.
    // A canvas (the main-thread fallback) is flipped by Cesium itself.
    const bitmap = await createImageBitmap(canvas, { imageOrientation: 'flipY' });
    self.postMessage({ id: m.id, bitmap }, [bitmap]);
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err?.message || err) });
  }
};
