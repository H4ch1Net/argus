import { computeViewportQuery } from '../sdk/viewport.js';

// Dev-only mock AIS source: synthetic vessels within the current view that move
// and report every couple of seconds, exercising the exact push pipeline the
// real AIS websocket feeds. Dev-gated + dynamic-imported.

const rand = (a, b) => a + Math.random() * (b - a);

export function createShipMockSource({ viewer, count = 24 }) {
  return (onBatch) => {
    let ships = null;

    const tick = () => {
      const b = computeViewportQuery(viewer).bbox;
      if (!ships) {
        ships = Array.from({ length: count }, (_, i) => ({
          mmsi: 900_000_000 + i,
          name: `MOCKSHIP ${i}`,
          lat: rand(b.lamin, b.lamax),
          lon: rand(b.lomin, b.lomax),
          cog: Math.random() * 360,
          sog: 2 + Math.random() * 18,
          heading: 511,
        }));
      }
      for (const s of ships) {
        const distNm = (s.sog * 2) / 3600; // 2s at SOG knots
        s.lat += (distNm / 60) * Math.cos((s.cog * Math.PI) / 180);
        s.lon +=
          ((distNm / 60) * Math.sin((s.cog * Math.PI) / 180)) /
          Math.cos((s.lat * Math.PI) / 180);
        if (s.lat < b.lamin || s.lat > b.lamax) s.lat = rand(b.lamin, b.lamax);
        if (s.lon < b.lomin || s.lon > b.lomax) s.lon = rand(b.lomin, b.lomax);
        s.heading = Math.round(s.cog);
      }
      onBatch(ships.map((s) => ({ ...s })));
    };

    tick();
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  };
}
