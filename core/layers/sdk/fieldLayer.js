import { computeViewportQuery } from './viewport.js';

// renderType 'field': a continuous field over the view (wind), drawn by the
// definition's own renderer instead of one marker per contact. Same layer
// contract as the others (start / stop / setEnabled / destroy, empty search):
//   source(query, signal) -> raw;  def.normalize(raw, query) -> field;
//   def.render.create(viewer, ctx) -> { setField(field), setVisible(on), destroy() }.
// Fetched for the view on start, after each camera stop (once the view has
// moved to a different grid), and every intervalMs; paused when backgrounded.

const DEFAULT_INTERVAL_MS = 15 * 60_000;

export function createFieldLayer(viewer, def, ctx) {
  const intervalMs = def.fetch?.intervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;
  let timer = null;
  let aborter = null;
  let renderer = null;
  let lastKey = '';
  let field = null;

  async function poll(force = false) {
    if (!running || document.hidden) return;
    const query = computeViewportQuery(viewer);
    // The field already fetched still serves this view: nothing to fetch.
    if (!force && field && def.covers?.(field, query)) return;
    const key = def.fieldKey ? def.fieldKey(query) : JSON.stringify(query.bbox ?? {});
    if (!force && key === lastKey && field) return;
    lastKey = key;
    aborter?.abort();
    const controller = new AbortController();
    aborter = controller;
    try {
      const raw = await ctx.source(query, controller.signal);
      if (!running || controller.signal.aborted) return;
      field = def.normalize(raw, query);
      renderer?.setField(field);
      ctx.onStatus?.({
        state: field ? 'ok' : 'error',
        count: field?.count ?? 0,
        note: def.statusNote?.(query, field) || undefined,
        message: field ? undefined : 'no field in the answer',
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      ctx.onStatus?.({
        state: 'error',
        status: err?.status,
        message: String(err?.message || err),
      });
    }
  }

  const onMoveEnd = () => poll();
  const onVisible = () => {
    renderer?.setVisible(running && !document.hidden);
    if (!document.hidden) poll();
  };

  return {
    id: def.id,
    start() {
      if (running) return;
      running = true;
      renderer ??= def.render.create(viewer, ctx);
      renderer.setVisible(true);
      if (field) renderer.setField(field);
      viewer.camera.moveEnd.addEventListener(onMoveEnd);
      document.addEventListener('visibilitychange', onVisible);
      poll(true);
      timer = setInterval(() => poll(true), intervalMs);
    },
    stop() {
      running = false;
      clearInterval(timer);
      timer = null;
      aborter?.abort();
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      document.removeEventListener('visibilitychange', onVisible);
      renderer?.setVisible(false);
    },
    setEnabled(on) {
      if (on) this.start();
      else this.stop();
    },
    destroy() {
      this.stop();
      renderer?.destroy();
      renderer = null;
    },
    /** The field's value at a point, for readouts (or null). */
    sample: (lon, lat) => (field && def.sample ? def.sample(field, lon, lat) : null),
    get size() {
      return field?.count ?? 0;
    },
    search: () => [],
    getRecord: () => null,
    forEachRecord() {},
    forEachVisible() {},
  };
}
