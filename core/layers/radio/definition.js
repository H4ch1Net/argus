import { parseRadio } from './parse.js';
import { describeRadio, radioSearchText } from './format.js';
import { ink } from '../sdk/colors.js';

// Public radio stations (Radio Browser) as a Layer SDK definition: one global
// catalogue of the most-played located stations, refreshed every 45 minutes
// (the proxy caches it for as long).

export const radioDefinition = {
  id: 'radio',
  fetch: { mode: 'poll', intervalMs: 45 * 60 * 1000, viewportBounded: false },
  interpolate: false,
  maxEntities: 1500,
  normalize: (raw) => parseRadio(raw),
  render: {
    renderType: 'point',
    style: () => ({ glyph: 'cross', pixelSize: 10, color: ink('teal') }),
  },
  describe: (n) => describeRadio(n),
  searchText: radioSearchText,
};
