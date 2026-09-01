import * as Cesium from 'cesium';
import { parseShodanFacets } from './parse.js';
import { shodanPixelSize, shodanColorHex, describeShodan } from './format.js';

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
    renderType: 'point',
    style: (n) => ({
      pixelSize: shodanPixelSize(n.meta.count),
      color: Cesium.Color.fromCssColorString(shodanColorHex(n.meta.count)).withAlpha(
        0.85,
      ),
      outlineColor: Cesium.Color.BLACK.withAlpha(0.4),
    }),
  },
  describe: (n) => describeShodan(n),
  searchText: (n) => n.meta.country,
};
