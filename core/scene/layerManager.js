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
export function createLayerManager(viewer, { readout, clock } = {}) {
  const entries = new Map(); // key -> { label, loadDef, makeSource, layer, enabled }
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());

  function register(key, { label, loadDef, makeSource }) {
    entries.set(key, { label, loadDef, makeSource, layer: null, enabled: false });
  }

  async function enable(key) {
    const e = entries.get(key);
    if (!e || e.enabled) return;
    if (!e.layer) {
      const source = await e.makeSource();
      if (!source) return; // no data source available; cannot enable
      const def = await e.loadDef();
      e.layer = createLayer(viewer, def, {
        source,
        onStatus: (s) => readout?.setLayerStatus?.(e.label, s),
        clock,
      });
    }
    e.layer.setEnabled(true);
    e.enabled = true;
    emit();
  }

  function disable(key) {
    const e = entries.get(key);
    if (!e || !e.enabled) return;
    e.layer.setEnabled(false);
    e.enabled = false;
    readout?.setLayerStatus?.(e.label, { state: 'off' }); // clear the readout row
    emit();
  }

  async function toggle(key) {
    const e = entries.get(key);
    if (!e) return;
    if (e.enabled) disable(key);
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
      })),
    activeLayers: () =>
      [...entries.values()].filter((e) => e.enabled && e.layer).map((e) => e.layer),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
