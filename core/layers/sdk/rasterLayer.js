import * as Cesium from 'cesium';

// The `raster` renderType: field / overlay layers (weather radar, satellite
// clouds, lightning density) through the same Layer SDK contract as entity
// layers, not a parallel subsystem (CLAUDE.md). The definition's source returns
// a raster SPEC instead of entities; the engine turns it into a Cesium imagery
// layer above the basemap and refreshes it on the poll interval:
//
//   { kind: 'wms', url, layers, parameters?, label?, credit?, maximumLevel?, rectangle? }
//   { kind: 'xyz', url /* {z}/{x}/{y} template */, label?, credit?, maximumLevel? }
//
// A spec whose `key` (default: its url + layers + parameters) has not changed is
// left alone, so polling only reloads tiles when the upstream time step moves.
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
  let imagery = null;
  let currentKey = '';

  // Keep the previous frame under the new one until the globe has finished
  // loading tiles (or 15 s at most), so a refresh never blanks the overlay.
  const retiring = new Set();
  function retireWhenLoaded(old) {
    retiring.add(old);
    let offProgress = null;
    let timeout = null;
    const done = () => {
      offProgress?.();
      clearTimeout(timeout);
      if (!retiring.delete(old)) return;
      if (viewer.imageryLayers.contains(old)) viewer.imageryLayers.remove(old, true);
      viewer.scene.requestRender();
    };
    const progress = viewer.scene.globe?.tileLoadProgressEvent;
    if (progress)
      offProgress = progress.addEventListener((queued) => queued === 0 && done());
    timeout = setTimeout(done, 15_000);
  }

  function removeImagery() {
    for (const old of retiring) {
      if (viewer.imageryLayers.contains(old)) viewer.imageryLayers.remove(old, true);
    }
    retiring.clear();
    if (imagery && viewer.imageryLayers.contains(imagery)) {
      viewer.imageryLayers.remove(imagery, true);
    }
    imagery = null;
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
      const key = rasterSpecKey(spec);
      if (key !== currentKey) {
        const layers = viewer.imageryLayers;
        const next = new Cesium.ImageryLayer(buildProvider(spec), { alpha });
        const old = imagery && layers.contains(imagery) ? imagery : null;
        // A refresh takes the old frame's place in the stack (so two overlays
        // keep their order); a first load goes on top of the basemap.
        if (old) layers.add(next, layers.indexOf(old) + 1);
        else layers.add(next);
        imagery = next;
        currentKey = key;
        if (old) retireWhenLoaded(old);
        viewer.scene.requestRender();
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
      refresh();
      timer = setInterval(refresh, intervalMs);
    },
    stop() {
      running = false;
      clearInterval(timer);
      timer = null;
      aborter?.abort();
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
    get size() {
      return imagery ? 1 : 0;
    },
    search: () => [],
    getRecord: () => null,
  };
}
