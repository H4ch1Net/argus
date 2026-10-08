import * as Cesium from 'cesium';

// A canvas drawn by a layer, shown as one imagery layer draped on the globe
// (terrain and all): the aurora oval, the night side, the air-quality field.
// One texture per update, no per-frame cost. Updates swap without flicker: the
// new image goes on top and the old one leaves once the globe has loaded it.
// A box crossing the antimeridian is split into two images (Cesium rectangles
// stay within -180..180). Browser only (canvas, Blob URLs).

/** Columns of a canvas as a new canvas. */
function slice(canvas, x0, x1) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, x1 - x0);
  c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, x0, 0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

/** [{ canvas, rect }] pieces of a canvas over [west, south, east, north] degrees. */
export function splitAtAntimeridian(canvas, [west, south, east, north]) {
  let w = west;
  let e = east;
  while (w < -180) {
    w += 360;
    e += 360;
  }
  while (w >= 180) {
    w -= 360;
    e -= 360;
  }
  if (e <= 180) return [{ canvas, rect: [w, south, e, north] }];
  const k = Math.round((canvas.width * (180 - w)) / (e - w));
  return [
    { canvas: slice(canvas, 0, k), rect: [w, south, 180, north] },
    { canvas: slice(canvas, k, canvas.width), rect: [-180, south, e - 360, north] },
  ].filter((p) => p.canvas.width > 0 && p.rect[2] > p.rect[0]);
}

const toUrl = (canvas) =>
  new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve({ url: canvas.toDataURL('image/png'), blob: false });
      return;
    }
    canvas.toBlob((blob) =>
      resolve(
        blob
          ? { url: URL.createObjectURL(blob), blob: true }
          : { url: canvas.toDataURL('image/png'), blob: false },
      ),
    );
  });

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ alpha?: number, credit?: string }} [opts]
 */
export function createCanvasImagery(viewer, { alpha = 1, credit } = {}) {
  const layers = viewer.imageryLayers;
  const scene = viewer.scene;
  const cesiumCredit = credit ? new Cesium.Credit(credit) : undefined;
  let current = []; // [{ layer, url, blob }]
  let visible = true;
  let generation = 0;
  let destroyed = false;

  const dispose = (list) => {
    for (const p of list) {
      if (layers.contains(p.layer)) layers.remove(p.layer, true);
      if (p.blob) URL.revokeObjectURL(p.url);
    }
  };

  // The new image is on screen once the globe's tile queue drains (or soon
  // after, whatever happens): only then does the old one leave.
  function whenLoaded(done) {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      off?.();
      clearTimeout(timer);
      done();
    };
    const off = scene.globe?.tileLoadProgressEvent?.addEventListener(
      (queued) => queued === 0 && finish(),
    );
    const timer = setTimeout(finish, 2500);
    scene.requestRender();
  }

  return {
    /** Show a canvas over [west, south, east, north] degrees (replaces the last). */
    async show(canvas, rect) {
      const gen = (generation += 1);
      const pieces = splitAtAntimeridian(canvas, rect);
      const urls = await Promise.all(pieces.map((p) => toUrl(p.canvas)));
      if (destroyed || gen !== generation) {
        for (const u of urls) if (u.blob) URL.revokeObjectURL(u.url);
        return;
      }
      const made = pieces.map((p, i) => {
        const provider = new Cesium.SingleTileImageryProvider({
          url: urls[i].url,
          rectangle: Cesium.Rectangle.fromDegrees(...p.rect),
          tileWidth: p.canvas.width,
          tileHeight: p.canvas.height,
          credit: cesiumCredit,
        });
        const layer = new Cesium.ImageryLayer(provider, { alpha, show: visible });
        layers.add(layer);
        return { layer, url: urls[i].url, blob: urls[i].blob };
      });
      const old = current;
      current = made;
      whenLoaded(() => {
        dispose(old);
        scene.requestRender();
      });
    },
    setVisible(on) {
      visible = Boolean(on);
      for (const p of current) p.layer.show = visible;
      scene.requestRender();
    },
    clear() {
      generation += 1;
      dispose(current);
      current = [];
      scene.requestRender();
    },
    destroy() {
      destroyed = true;
      this.clear();
    },
  };
}

/** A canvas holding RGBA pixels (width x height). */
export function pixelsToCanvas(pixels, width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  return c;
}
