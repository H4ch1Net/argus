import { ink } from '../sdk/colors.js';
import { createRingMemo } from '../sdk/rings.js';
import { parsePerimeters } from './parse.js';
import { describePerimeter, perimeterInkName, perimeterSearchText } from './format.js';

// Wildfire perimeters (NIFC WFIGS, US interagency) as a Layer SDK polygon
// layer: a translucent ground fill and outline per mapped area, coloured by
// containment. The current-season snapshot is national and small (the proxy
// caches it for 5 minutes and every client shares it), so it is fetched whole
// rather than per view; Cesium culls what is off screen.

const FILL = { error: 0.28, white: 0.2, muted: 0.14 };

export const perimetersDefinition = {
  id: 'perimeters',
  fetch: { mode: 'poll', intervalMs: 5 * 60 * 1000, viewportBounded: false },
  interpolate: false,
  maxEntities: 3000,
  normalize: (() => {
    const memo = createRingMemo();
    return (raw) => memo(parsePerimeters(raw));
  })(),
  statusNote: (_q, raw) => (raw && !raw.features?.length ? 'no active perimeters' : ''),
  render: {
    renderType: 'polygon',
    width: 1.5,
    style: (n) => {
      const name = perimeterInkName(n.meta.containedPct);
      return { color: ink(name), fillAlpha: FILL[name], outlineColor: ink(name, 0.9) };
    },
  },
  describe: (n) => describePerimeter(n),
  searchText: perimeterSearchText,
};
