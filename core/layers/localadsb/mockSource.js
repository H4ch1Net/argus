// Dev / demo-only receivers: dump1090- and skyaware978-shaped aircraft.json
// documents with a few simulated aircraft circling the centre of the current
// view, in the combined shape createLocalReceiverSource returns. One aircraft is
// heard on both bands and two only on 978 MHz UAT (low, slow general aviation),
// so the merged card ("1090 MHz + 978 MHz UAT") can be exercised offline.

import { computeViewportQuery } from '../sdk/viewport.js';

export function createLocalAdsbMockSource({ viewer } = {}) {
  let centre = null;
  return async (query) => {
    const b = query?.bbox ?? (viewer ? computeViewportQuery(viewer).bbox : null);
    centre ??= b ? [(b.lamin + b.lamax) / 2, (b.lomin + b.lomax) / 2] : [51.47, -0.45];
    const t = Date.now() / 1000;
    const circling = (i, { hex, flight, alt, gs, r0 = 0.15, step = 0.08 }) => {
      const ang = t / (200 + i * 40) + i;
      const r = r0 + i * step;
      return {
        hex,
        flight,
        lat: centre[0] + r * Math.sin(ang),
        lon: centre[1] + (r * Math.cos(ang)) / Math.cos((centre[0] * Math.PI) / 180),
        alt_baro: alt,
        gs,
        track: (((90 - (ang * 180) / Math.PI) % 360) + 360) % 360,
        seen: 0.3,
        seen_pos: 0.5,
      };
    };
    const ten90 = Array.from({ length: 5 }, (_, i) =>
      circling(i, {
        hex: `de10${i}0`,
        flight: `RX${i + 1}`,
        alt: 2000 + i * 3000,
        gs: 180 + i * 40,
      }),
    );
    const uat = [
      // The first 1090 aircraft is ADS-B Out on both bands (heard twice).
      { ...ten90[0], seen_pos: 1.5 },
      ...[0, 1].map((i) =>
        circling(i, {
          hex: `de97${i}0`,
          flight: `UAT${i + 1}`,
          alt: 1500 + i * 1000,
          gs: 95 + i * 20,
          r0: 0.08,
          step: 0.05,
        }),
      ),
    ];
    return {
      demo: true,
      feeds: [
        { band: '1090', payload: { now: t, aircraft: ten90 } },
        { band: '978', payload: { now: t, aircraft: uat } },
      ],
    };
  };
}
