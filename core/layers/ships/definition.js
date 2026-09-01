import * as Cesium from 'cesium';
import { describeShip } from './format.js';

// Ships (AIS) as a Layer SDK definition. This is the first PUSH layer: reports
// stream in over the proxy websocket, entities are upserted as they report and
// removed when they go stale. Ships are movers, so positions interpolate between
// reports. AIS position reports carry SOG (knots), COG, and TrueHeading.

let shipImageCache = null;
function shipImage() {
  if (shipImageCache) return shipImageCache;
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 24;
  const g = c.getContext('2d');
  g.translate(12, 12);
  g.beginPath();
  g.moveTo(0, -10);
  g.lineTo(5, 8);
  g.lineTo(0, 4);
  g.lineTo(-5, 8);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
  shipImageCache = c;
  return c;
}

const headingOf = (n) => {
  const h = n.meta.heading;
  return h != null && h !== 511 ? h : (n.meta.cog ?? 0);
};

function toNormalized(ship) {
  return {
    id: String(ship.mmsi),
    type: 'ship',
    position: { longitude: ship.lon, latitude: ship.lat, altitude: 0 },
    velocity: { speed: ship.sog, heading: ship.heading, course: ship.cog },
    meta: ship,
  };
}

export const shipsDefinition = {
  id: 'ships',
  fetch: { mode: 'push' },
  interpolate: true,
  interpolateLagMs: 5000, // AIS reports are irregular; a modest render delay
  staleMs: 180_000, // drop a vessel after 3 min without a report
  maxEntities: 3000,
  normalize: (ships) => ships.map(toNormalized),
  render: {
    renderType: 'billboard',
    style: (n) => ({
      image: shipImage(),
      scale: 0.6,
      rotationRadians: -Cesium.Math.toRadians(headingOf(n)),
      color: Cesium.Color.fromCssColorString('#7fd4ff'),
    }),
  },
  describe: (n) => describeShip(n),
  searchText: (n) => `${n.meta.name || ''} ${n.meta.mmsi}`,
};
