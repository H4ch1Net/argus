import { createLayer } from '../layers/sdk/index.js';

// Layer manager: the registry of available layers and their on/off state. It
// owns lazy creation (a layer is built the first time it is enabled), start/stop,
// and change notification so presets and toggle UI stay in sync. Layers are
// created from an async definition + source, so the app can register a layer
// without loading its (Cesium-heavy) code until it is first switched on.

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ readout?: { setLayerStatus?: (label: string, s: object) => void } }} [opts]
 */
export function createLayerManager(
  viewer,
  { readout, clock, animationFps, groundClamp = false } = {},
) {
  const entries = new Map(); // key -> { label, loadDef, makeSource, layer, enabled }
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());
  // Per-layer status (count, error, note) for the layer menu, separate from the
  // on/off change stream so a 15 s poll does not rebuild the menu.
  const statusListeners = new Set();
  const emitStatus = (key, s) => statusListeners.forEach((fn) => fn(key, s));

  // decorateStatus: an optional (status) => status the app applies before
  // anyone sees it (main.js marks an answer the proxy served stale).
  function register(
    key,
    { label, loadDef, makeSource, demo = false, group = null, decorateStatus = null },
  ) {
    entries.set(key, {
      label,
      loadDef,
      makeSource,
      demo,
      group,
      decorateStatus,
      layer: null,
      enabled: false,
      want: false,
      pending: null,
    });
  }

  // enable() awaits the layer's (lazy) source and definition. Two calls in that
  // window (a double-tapped preset, a preset tapped while another loads) must
  // share one load, or the first layer is orphaned, still polling; and a
  // disable() that lands meanwhile must win. `want` records the latest request.
  async function enable(key) {
    const e = entries.get(key);
    if (!e) return;
    e.want = true;
    if (e.enabled) return;
    if (!e.layer) {
      if (!e.pending) {
        e.status = { state: 'loading' };
        emitStatus(key, e.status);
      }
      e.pending ??= (async () => {
        try {
          const source = await e.makeSource();
          if (!source) {
            // No data source here (a layer that needs the live proxy, or a
            // key it does not have): say so instead of failing silently.
            e.status = {
              state: 'unavailable',
              message:
                'No data source: this layer needs the Argus proxy (and its key, if any).',
            };
            emitStatus(key, e.status);
            return null;
          }
          const def = await e.loadDef();
          return createLayer(viewer, def, {
            source,
            onStatus: (raw) => {
              const s = e.decorateStatus?.(raw) ?? raw;
              e.status = s;
              readout?.setLayerStatus?.(e.label, s);
              emitStatus(key, s);
            },
            clock,
            animationFps,
            groundClamp,
          });
        } finally {
          e.pending = null;
        }
      })();
      const layer = await e.pending;
      if (layer && !e.layer) e.layer = layer;
      if (!e.layer) return;
    }
    if (!e.want || e.enabled) return; // switched off while loading, or already on
    e.layer.setEnabled(true);
    e.enabled = true;
    emit();
  }

  function disable(key) {
    const e = entries.get(key);
    if (!e) return;
    e.want = false;
    if (!e.enabled) return;
    e.layer.setEnabled(false);
    e.enabled = false;
    e.status = { state: 'off' };
    readout?.setLayerStatus?.(e.label, e.status); // clear the readout row
    emitStatus(key, e.status);
    emit();
  }

  async function toggle(key) {
    const e = entries.get(key);
    if (!e) return;
    // A second tap while the layer is still loading switches it back off.
    if (e.enabled || e.want) disable(key);
    else await enable(key);
  }

  return {
    register,
    enable,
    disable,
    toggle,
    keys: () => [...entries.keys()],
    isEnabled: (key) => Boolean(entries.get(key)?.enabled),
    getLayer: (key) => entries.get(key)?.layer ?? null,
    list: () =>
      [...entries.entries()].map(([key, e]) => ({
        key,
        label: e.label,
        enabled: e.enabled,
        demo: e.demo,
        group: e.group,
      })),
    activeLayers: () =>
      [...entries.values()].filter((e) => e.enabled && e.layer).map((e) => e.layer),
    /** Enabled layers with their manager keys: [{ key, label, layer }]. */
    active: () =>
      [...entries.entries()]
        .filter(([, e]) => e.enabled && e.layer)
        .map(([key, e]) => ({ key, label: e.label, layer: e.layer })),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Status updates per layer: fn(key, { state, count, note, message }). */
    subscribeStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    statusOf: (key) => entries.get(key)?.status ?? null,
  };
}
