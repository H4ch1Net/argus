// Dev / demo-only receiver: a dump1090-shaped aircraft.json with a few
// simulated aircraft circling the centre of the current view.

import { computeViewportQuery } from '../sdk/viewport.js';

export function createLocalAdsbMockSource({ viewer } = {}) {
  let centre = null;
  return async (query) => {
    const b = query?.bbox ?? (viewer ? computeViewportQuery(viewer).bbox : null);
    centre ??= b ? [(b.lamin + b.lamax) / 2, (b.lomin + b.lomax) / 2] : [51.47, -0.45];
    const t = Date.now() / 1000;
    return {
      demo: true,
      now: t,
      aircraft: Array.from({ length: 5 }, (_, i) => {
        const ang = t / (200 + i * 40) + i;
        const r = 0.15 + i * 0.08;
        return {
          hex: `de10${i}0`,
          flight: `RX${i + 1}`,
          lat: centre[0] + r * Math.sin(ang),
          lon: centre[1] + (r * Math.cos(ang)) / Math.cos((centre[0] * Math.PI) / 180),
          alt_baro: 2000 + i * 3000,
          gs: 180 + i * 40,
          track: (((90 - (ang * 180) / Math.PI) % 360) + 360) % 360,
          seen_pos: 0.5,
        };
      }),
    };
  };
}
