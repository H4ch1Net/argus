// The vector basemap on the main thread: finds the current OpenFreeMap tile
// set through the proxy, starts the basemap worker (or, where a WebView has no
// OffscreenCanvas, draws on the main thread), and turns tile requests into
// images for the Cesium imagery provider (./provider.js). No Cesium here.

import { createTileEngine } from './tiles.js';

export const BASEMAP_FEED = 'openfreemap';
export const BASEMAP_TILES_FEED = 'openfreemap-tiles';
export const BASEMAP_TILEJSON = '/planet';
/** A versioned tile path from the TileJSON (pinned the same way in the proxy). */
export const TILE_PATH = /^\/planet\/(\d{8}_\d{6}_pt)\/\{z\}\/\{x\}\/\{y\}\.pbf$/;

/** Pixels drawn per tile (Cesium is told 256: the map is twice as dense). */
export const TILE_PX = 512;

/**
 * The proxy URL template of the source tiles, from the TileJSON's tile URL.
 * @returns {string|null}
 */
export function tileTemplate(proxyClient, tilejson) {
  const url = tilejson?.tiles?.[0];
  if (typeof url !== 'string') return null;
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = TILE_PATH.exec(decodeURI(path));
  if (!m) return null;
  return `${proxyClient.buildUrl(BASEMAP_TILES_FEED, `/planet/${m[1]}/`)}{z}/{x}/{y}.pbf`;
}

/**
 * @param {{ proxyClient: object, workers?: boolean }} opts
 * @returns {{ ready: Promise<void>, render: Function, stats: Function, destroy: Function }}
 */
export function createVectorBasemap({ proxyClient, workers = true }) {
  let worker = null;
  let engine = null;
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject }

  const useWorker =
    workers && typeof Worker === 'function' && typeof OffscreenCanvas === 'function';

  const ready = (async () => {
    const tilejson = await proxyClient.getJson(BASEMAP_FEED, BASEMAP_TILEJSON);
    const template = tileTemplate(proxyClient, tilejson);
    if (!template) throw new Error('basemap: unexpected tile set description');
    if (useWorker) {
      try {
        worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = (e) => {
          const p = pending.get(e.data.id);
          if (!p) return;
          pending.delete(e.data.id);
          if (e.data.error) p.reject(new Error(e.data.error));
          else p.resolve(e.data.bitmap ?? null);
        };
        worker.onerror = (e) => {
          // A worker that cannot start (old WebView, blocked module workers):
          // fall back to drawing here.
          e.preventDefault?.();
          fallback(template);
        };
        worker.postMessage({ type: 'init', template });
        return;
      } catch {
        worker = null;
      }
    }
    fallback(template);
  })();

  function fallback(template) {
    worker?.terminate?.();
    worker = null;
    engine = createTileEngine({
      template,
      makeCanvas: (w, h) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
      },
    });
    for (const [, p] of pending)
      p.reject(new Error('basemap: redrawing on the main thread'));
    pending.clear();
  }

  /**
   * One tile as an image (ImageBitmap from the worker, a canvas otherwise), or
   * null when a label tile has nothing to show.
   */
  async function render(kind, z, x, y) {
    await ready;
    const pr = TILE_PX / 256;
    if (engine) return engine.render(kind, z, x, y, TILE_PX, pr);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'render', id, kind, z, x, y, size: TILE_PX, pr });
    });
  }

  return {
    ready,
    render,
    get usesWorker() {
      return Boolean(worker);
    },
    stats: () => ({
      pending: pending.size,
      worker: Boolean(worker),
      ...(engine?.stats() ?? {}),
    }),
    destroy() {
      worker?.terminate?.();
      worker = null;
      for (const [, p] of pending) p.reject(new Error('basemap closed'));
      pending.clear();
    },
  };
}
