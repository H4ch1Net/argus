import { parseShodanFacets } from './parse.js';
import { shodanPixelSize, describeShodan } from './format.js';
import { ink } from '../sdk/colors.js';

// Shodan exposed-device density as a Layer SDK definition. Visualization /
// awareness-only (locked decision): a country-facet SNAPSHOT from the credit-free
// /host/count endpoint, rendered as a density map. Never live search-on-pan, and
// the proxy's budget governor guards the metered endpoints regardless. Inputs are
// assets (services, counts), never people.

export const shodanDefinition = {
  id: 'shodan',
  fetch: { mode: 'once' }, // one snapshot; not tied to the viewport
  interpolate: false,
  maxEntities: 300,
  normalize: (json) => parseShodanFacets(json, 'country'),
  render: {
    // Exposure density per country: hollow squares sized by the log count.
    renderType: 'point',
    style: (n) => ({
      glyph: 'frame',
      pixelSize: Math.round(shodanPixelSize(n.meta.count) * 1.1),
      color: ink('gray', 0.85),
    }),
  },
  describe: (n) => describeShodan(n),
  searchText: (n) => n.meta.country,
};
