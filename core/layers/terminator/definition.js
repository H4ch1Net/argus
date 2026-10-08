import { createCanvasImagery } from '../aurora/canvasImagery.js';
import { lightsIntensity, nightPixels, terminatorWidth } from './night.js';

// Day/night terminator + city lights as a Layer SDK 'field' layer. Computed,
// not fetched: the source only stamps the time (and, once, fetches the NASA
// Black Marble night-lights image through the proxy's 'gibs-night' feed). The
// renderer draws the night side, the terminator hairline and the lights on the
// night side into one equirectangular texture (core/layers/terminator/night.js)
// and shows it as one imagery layer, redrawn every 2 minutes (the terminator
// moves a quarter degree a minute). 1024 x 512 on phones, 2048 x 1024 on the
// full tier; the lights image is decoded once.

const REFRESH_MS = 2 * 60_000;

export const terminatorDefinition = {
  id: 'terminator',
  fetch: { mode: 'viewport', intervalMs: REFRESH_MS },
  fieldKey: () => 'global',
  normalize: (raw) => (raw ? { at: raw.at ?? Date.now(), lights: raw.lights ?? null, count: 1 } : null),
  statusNote: (_q, field) =>
    field ? `${new Date(field.at).toISOString().slice(11, 16)}Z` : '',
  render: {
    renderType: 'field',
    create: (viewer, ctx) => {
      const width = terminatorWidth(ctx?.animationFps ?? 30);
      const height = width / 2;
      const overlay = createCanvasImagery(viewer, {
        alpha: 1,
        credit: 'Night lights: NASA Black Marble (GIBS)',
      });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const g = canvas.getContext('2d');
      const image = g.createImageData(width, height);
      let lights = null; // Uint8Array intensities, once decoded
      let lightsFrom = null; // the promise they came from
      let last = null;

      async function decodeLights(promise) {
        lightsFrom = promise;
        try {
          const bytes = await promise;
          if (!bytes || lightsFrom !== promise) return;
          const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
          const c = document.createElement('canvas');
          c.width = width;
          c.height = height;
          const cg = c.getContext('2d', { willReadFrequently: true });
          cg.drawImage(bitmap, 0, 0, width, height);
          bitmap.close?.();
          lights = lightsIntensity(cg.getImageData(0, 0, width, height).data, width, height);
          if (last) draw(last);
        } catch {
          // No lights (offline, refused): the shade and line still show.
        }
      }

      function draw(field) {
        last = field;
        nightPixels(new Date(field.at), width, height, { lights, out: image.data });
        g.putImageData(image, 0, 0);
        overlay.show(canvas, [-180, -90, 180, 90]);
      }

      return {
        setField(field) {
          if (!field) return;
          if (field.lights && field.lights !== lightsFrom) decodeLights(field.lights);
          draw(field);
        },
        setVisible: (on) => overlay.setVisible(on),
        destroy: () => overlay.destroy(),
      };
    },
  },
};
