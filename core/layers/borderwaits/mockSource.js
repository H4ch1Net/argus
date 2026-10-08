// Dev / demo-only border waits: a handful of real crossings from the bundled
// table with simulated waits, so the layer works offline (cards say
// "demo (simulated)").

import { PORTS } from './data/ports.js';

const DEMO_IDS = [
  'san-ysidro',
  'el-paso-bota',
  'laredo-2',
  'blaine-peace-arch',
  'detroit-ambassador',
  'peace-bridge',
];

export function createBorderWaitMockSource() {
  return async () => {
    const r = (n) => Math.round(Math.random() * n);
    return {
      failed: 0,
      unplaced: 0,
      camerasLinked: false,
      ports: PORTS.filter((p) => DEMO_IDS.includes(p.id)).map((p) => ({
        ...p,
        demo: true,
        cbp: [
          {
            key: `demo-${p.id}`,
            port: p.name,
            crossing: '',
            border: p.border,
            status: 'Open',
            hours: '24 hrs/day',
            updated: 'simulated',
            notice: null,
            lanes: [
              {
                label: 'Passenger',
                kind: 'passenger_vehicle_lanes',
                delay: r(120),
                open: 1 + r(10),
                closed: false,
                pending: false,
                updated: null,
              },
              {
                label: 'Pedestrian',
                kind: 'pedestrian_lanes',
                delay: r(60),
                open: 1 + r(4),
                closed: false,
                pending: false,
                updated: null,
              },
            ],
          },
        ],
        cbsa: null,
        cameras: null,
      })),
    };
  };
}
