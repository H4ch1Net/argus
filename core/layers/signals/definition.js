import { normalizeSignals, CROSSINGS_MAX_VIEW_KM } from './parse.js';
import { describeSignal, signalSearchText } from './format.js';
import { selectScope } from '../surveillance/select.js';
import { tiledNote, viewSizeKm } from '../overpass/tiles.js';
import { layerInk } from '../sdk/colors.js';

// Traffic lights from OpenStreetMap (./parse.js): a static point layer, loaded
// only when the view is about 20 km across or less ("zoom in to load"
// otherwise), fetched once per tile and kept for a day. The ctOS signal-head
// glyph; junction signals full size, pedestrian crossing signals smaller and
// only in views under 6 km (not at all on the minimal tier). Everything in view is drawn, capped nearest the
// middle first (fewer on the minimal tier, the car and weak phones).

/**
 * @param {{ tier?: string, scope?: { anchor?: () => ({ lat: number, lon: number })|null,
 *   view?: () => object|null } }} [opts]
 */
export function createSignalsDefinition({ tier, scope } = {}) {
  const maxEntities = tier === 'minimal' ? 1200 : 2500;
  // Pedestrian crossing signals: close views only, and never on the minimal
  // tier (the car, weak phones), where they would crowd out the junctions.
  const crossingsKm = tier === 'minimal' ? 0 : CROSSINGS_MAX_VIEW_KM;
  const styles = {
    junction: { glyph: 'signal', pixelSize: 11, color: layerInk('signals', 0.95) },
    crossing: { glyph: 'signal', pixelSize: 8, color: layerInk('signals', 0.6) },
  };
  return {
    id: 'signals',
    // Tiled and kept by the source (./parse.js createSignalsSource); RELOAD
    // reaches it as query.reload.
    fetch: { mode: 'viewport' },
    statusNote: (_q, raw) => tiledNote(raw),
    interpolate: false,
    maxEntities,
    normalize: (raw) => normalizeSignals(raw),
    select: (list) => {
      const view = scope?.view?.() ?? null;
      const close = view && viewSizeKm(view).across <= crossingsKm;
      const shown = close ? list : list.filter((n) => n.meta.kind !== 'crossing');
      return selectScope(shown, {
        mode: 'all',
        anchor: scope?.anchor?.() ?? null,
        view,
        max: maxEntities,
      }).list;
    },
    render: {
      renderType: 'point',
      style: (n) => styles[n.meta.kind] ?? styles.junction,
    },
    describe: (n) => describeSignal(n),
    searchText: (n) => signalSearchText(n),
  };
}

export const signalsDefinition = createSignalsDefinition();
