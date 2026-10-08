import { describeShip, shipHeading, shipToNormalized, shipSearchText } from './format.js';
import { ink } from '../sdk/colors.js';

// Ships (AIS) as a Layer SDK definition. This is the first PUSH layer: reports
// stream in over the proxy websocket, entities are upserted as they report and
// removed when they go stale. Ships are movers, so positions interpolate between
// reports. AIS position reports carry SOG (knots), COG, and TrueHeading.

export const shipsDefinition = {
  id: 'ships',
  fetch: { mode: 'push' },
  interpolate: true,
  interpolateLagMs: 5000, // AIS reports are irregular; a modest render delay
  staleMs: 180_000, // drop a vessel after 3 min without a report
  maxEntities: 3000,
  normalize: (ships) => ships.map(shipToNormalized),
  render: {
    // A hull in plan view, bow on the heading, a touch larger when under way.
    renderType: 'point',
    style: (n) => ({
      glyph: 'hull',
      pixelSize: (n.meta.sog ?? 0) > 1 ? 16 : 13,
      headingDeg: shipHeading(n),
      color: ink('cyan'),
    }),
  },
  describe: (n) => describeShip(n),
  searchText: shipSearchText,
};
