import { shodanToNormalized } from './parse.js';
import { describeShodan, shodanPixelSize, shodanSearchText } from './format.js';
import { ink } from '../sdk/colors.js';

// Shodan exposed-device density as a Layer SDK definition. Visualization /
// awareness-only (locked decision): a country-facet SNAPSHOT of one curated
// query (snapshots.js) from the credit-free /host/count endpoint, rendered as
// a density map, plus, when switched on in VIEW > SHODAN, the hosts of a
// one-page sample of the same snapshot (one query credit, cached 12 hours).
// Never live search-on-pan: fetched once, and again only when the snapshot
// or the sample switch changes; the proxy pins the query and governs the
// credits regardless. Inputs are assets (services, counts), never people.

export const shodanDefinition = {
  id: 'shodan',
  fetch: { mode: 'once' }, // one snapshot; not tied to the viewport
  interpolate: false,
  maxEntities: 400,
  normalize: (raw) => shodanToNormalized(raw),
  render: {
    // Exposure density per country: hollow squares sized by the log count;
    // sampled hosts: small nodes.
    renderType: 'point',
    style: (n) =>
      n.type === 'shodan-host'
        ? { glyph: 'node', pixelSize: 10, color: ink('white', 0.9) }
        : {
            glyph: 'frame',
            pixelSize: Math.round(shodanPixelSize(n.meta.count) * 1.1),
            color: ink('gray', 0.85),
          },
  },
  describe: (n) => describeShodan(n),
  searchText: shodanSearchText,
};
