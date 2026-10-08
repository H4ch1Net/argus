import * as Cesium from 'cesium';
import { createFrameSwapper } from './rasterSwap.js';

// The `raster` renderType: field / overlay layers (weather radar, satellite
// clouds, lightning density) through the same Layer SDK contract as entity
// layers, not a parallel subsystem (CLAUDE.md). The definition's source returns
// a raster SPEC instead of entities; the engine turns it into a Cesium imagery
// layer above the basemap and refreshes it on the poll interval:
//
//   { kind: 'wms', url, layers, parameters?, label?, credit?, maximumLevel?, rectangle? }
//   { kind: 'xyz', url /* {z}/{x}/{y} template */, label?, credit?, maximumLevel? }
//
//   { kind: 'empty', label? }   nothing to show now (e.g. no weather frame near
//                               the timeline's target): the overlay is cleared
//
// A spec whose `key` (default: its url + layers + parameters) has not changed is
// left alone, so polling only reloads tiles when the upstream time step moves.
// Frames swap double-buffered (rasterSwap.js): a new one loads hidden and
// replaces the old in one step, so stepping a timeline never flickers. A source
// may carry subscribe(onChange) -> unsubscribe (the weather timeline's sources
// do): the engine subscribes while running and reloads on each change instead
// of waiting for the next poll. A source may also carry shown(spec): the engine
// calls it when that spec's frame is on screen (an 'empty' spec once cleared).
// Rasters have no entities, so search and picking return nothing.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Stable identity of a spec, so an unchanged raster is not reloaded. Pure. */
export function rasterSpecKey(spec) {
  if (!spec) return '';
  return spec.key ?? JSON.stringify([spec.kind, spec.url, spec.layers, spec.parameters]);
}

function buildProvider(spec) {
  const credit = spec.credit ? new Cesium.Credit(spec.credit) : undefined;
  const rectangle = spec.rectangle
    ? Cesium.Rectangle.fromDegrees(...spec.rectangle) // [west, south, east, north]
    : undefined;
  if (spec.kind === 'wms') {
    return new Cesium.WebMapServiceImageryProvider({
      url: spec.url,
      layers: spec.layers,
      parameters: { transparent: true, format: 'image/png', ...(spec.parameters ?? {}) },
      tileWidth: 256,
      tileHeight: 256,
      maximumLevel: spec.maximumLevel,
      rectangle,
      credit,
      enablePickFeatures: false,
    });
  }
  if (spec.kind === 'xyz') {
    return new Cesium.UrlTemplateImageryProvider({
      url: spec.url,
      maximumLevel: spec.maximumLevel ?? 12,
      rectangle,
      credit,
    });
  }
  throw new Error(`raster spec kind "${spec.kind}" is not supported`);
}

/**
 * @param {import('cesium').Viewer} viewer
 * @param {object} def   LayerDefinition with render.renderType 'raster'
 *                       (render.alpha optional, default 0.7)
 * @param {{ source: Function, onStatus?: Function }} ctx
 */
export function createRasterLayer(viewer, def, ctx) {
  const intervalMs = def.fetch?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const alpha = def.render?.alpha ?? 0.7;
  let running = false;
  let timer = null;
  let aborter = null;
  let currentKey = '';
  let unsubscribeSource = null;

  const layers = viewer.imageryLayers;
  const specs = new WeakMap(); // imagery layer -> the spec it shows
  const reportShown = (spec) => {
    try {
      ctx.source.shown?.(spec);
    } catch {
      // a reporting hook must never break the overlay
    }
  };
  const swapper = createFrameSwapper({
    // A new frame goes just above the one it replaces (two overlays keep their
    // order); a first frame goes on top of the basemap.
    add(next, below, hidden) {
      if (hidden) next.alpha = 0;
      if (below && layers.contains(below)) layers.add(next, layers.indexOf(below) + 1);
      else layers.add(next);
      viewer.scene.requestRender();
    },
    reveal(layer) {
      layer.alpha = alpha;
      viewer.scene.requestRender();
    },
    remove(layer) {
      if (layers.contains(layer)) layers.remove(layer, true);
      viewer.scene.requestRender();
    },
    // Loaded when the globe's tile queue drains after the frame went up, or
    // when the first frame rendered with it leaves nothing queued (the frame is
    // out of view, or its tiles were cached).
    whenLoaded(_layer, done) {
      const globe = viewer.scene.globe;
      const offProgress = globe?.tileLoadProgressEvent?.addEventListener(
        (queued) => queued === 0 && done(),
      );
      const offRender = viewer.scene.postRender.addEventListener(() => {
        offRender();
        if (globe?.tilesLoaded) done();
      });
      viewer.scene.requestRender();
      return () => {
        offProgress?.();
        offRender();
      };
    },
    onShown(layer) {
      const spec = specs.get(layer);
      if (spec) reportShown(spec);
    },
  });

  function removeImagery() {
    swapper.clear();
    currentKey = '';
  }

  async function refresh() {
    if (!running) return;
    aborter?.abort();
    const controller = new AbortController();
    aborter = controller;
    try {
      const spec = await ctx.source({}, controller.signal);
      if (!running || controller.signal.aborted) return;
      if (!spec) throw new Error('no raster available');
      if (spec.kind === 'empty') {
        removeImagery();
        reportShown(spec);
        ctx.onStatus?.({ state: 'ok', count: 0, reason: spec.label, note: spec.label });
        return;
      }
      const key = rasterSpecKey(spec);
      if (key !== currentKey) {
        const next = new Cesium.ImageryLayer(buildProvider(spec), { alpha });
        specs.set(next, spec);
        currentKey = key;
        swapper.show(next);
      } else if (!swapper.pending && swapper.shown) {
        reportShown(specs.get(swapper.shown) ?? spec);
      }
      ctx.onStatus?.({ state: 'ok', count: 1, reason: spec.label });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      ctx.onStatus?.({ state: 'error', message: String(err?.message || err) });
    }
  }

  function onVisibilityChange() {
    if (!running) return;
    if (document.hidden) {
      clearInterval(timer);
      timer = null;
    } else if (!timer) {
      refresh();
      timer = setInterval(refresh, intervalMs);
    }
  }

  return {
    id: def.id,
    start() {
      if (running) return;
      running = true;
      document.addEventListener('visibilitychange', onVisibilityChange);
      if (typeof ctx.source.subscribe === 'function') {
        // Backgrounded, nothing reloads; becoming visible refreshes anyway.
        unsubscribeSource = ctx.source.subscribe(() => {
          if (!document.hidden) refresh();
        });
      }
      refresh();
      timer = setInterval(refresh, intervalMs);
    },
    stop() {
      running = false;
      clearInterval(timer);
      timer = null;
      aborter?.abort();
      unsubscribeSource?.();
      unsubscribeSource = null;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      removeImagery();
      viewer.scene.requestRender();
    },
    setEnabled(on) {
      if (on) this.start();
      else this.stop();
    },
    destroy() {
      this.stop();
    },
    /** Reload now (e.g. after the source's inputs changed). */
    refresh,
    get size() {
      return swapper.shown ? 1 : 0;
    },
    search: () => [],
    getRecord: () => null,
  };
}
