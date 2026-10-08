// Dev / demo-only transit source: simulated buses circling each covered city,
// encoded as real GTFS-RT bytes so the demo runs through the same decoder and
// selection logic as live data. Cards say "demo (simulated)".

import { TRANSIT_AGENCIES } from './agencies.js';
import { createTransitSource } from './source.js';
import { encodeVehicleFeed } from './encode.js';

export function createTransitMockSource({ perAgency = 24 } = {}) {
  const agencies = TRANSIT_AGENCIES.map((a) => ({ ...a, demo: true }));
  const fleets = new Map();
  const fleetFor = (a) => {
    if (!fleets.has(a.feedId)) {
      const rKm = Math.min(a.radiusKm, 25);
      fleets.set(
        a.feedId,
        Array.from({ length: perAgency }, (_, i) => ({
          id: `${i}`,
          routeId: String(1 + (i % 8)),
          ring: (rKm * (0.2 + 0.8 * Math.random())) / 111.32,
          phase: Math.random() * Math.PI * 2,
          dir: i % 2 ? 1 : -1,
        })),
      );
    }
    return fleets.get(a.feedId);
  };
  const proxyClient = {
    async getBytes(feedId) {
      const a = agencies.find((x) => x.feedId === feedId);
      const t = Date.now() / 1000;
      const [lat0, lon0] = a.center;
      const vehicles = fleetFor(a).map((v) => {
        const ang = v.phase + v.dir * t * 0.002;
        return {
          id: v.id,
          vehicleId: `demo-${v.id}`,
          label: `Demo ${v.id}`,
          routeId: v.routeId,
          lat: lat0 + v.ring * Math.sin(ang),
          lon: lon0 + (v.ring * Math.cos(ang)) / Math.cos((lat0 * Math.PI) / 180),
          bearing: ((((v.dir > 0 ? 0 : 180) - (ang * 180) / Math.PI) % 360) + 360) % 360,
          speed: 9,
          status: 'in transit',
          timestamp: Math.floor(t),
        };
      });
      return encodeVehicleFeed({ timestamp: Math.floor(t), vehicles });
    },
  };
  return createTransitSource({ proxyClient, agencies });
}
