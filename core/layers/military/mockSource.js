// Dev / demo-only military aircraft: an adsb.lol-shaped { ac } payload with a
// few simulated tracks so the layer can be exercised offline. Labelled demo in
// the card's source row; never shipped in a production build.

const START = [
  { hex: 'de0001', flight: 'DEMO01', t: 'C17', lat: 38.8, lon: -76.9, track: 60 },
  { hex: 'de0002', flight: 'DEMO02', t: 'K35R', lat: 49.4, lon: 7.6, track: 110 },
  { hex: 'de0003', flight: 'DEMO03', t: 'P8', lat: 35.4, lon: 139.5, track: 200 },
  { hex: 'de0004', flight: 'DEMO04', t: 'A400', lat: 51.7, lon: -1.8, track: 300 },
  { hex: 'de0005', flight: 'DEMO05', t: 'C130', lat: -33.9, lon: 151.0, track: 20 },
  { hex: 'de0006', flight: 'DEMO06', t: 'E3TF', lat: 37.1, lon: 14.9, track: 160 },
];

export function createMilitaryMockSource({ stepSeconds = 15 } = {}) {
  const planes = START.map((p) => ({ ...p, gs: 300 + Math.random() * 150 }));
  return async () => {
    for (const p of planes) {
      const nm = (p.gs * stepSeconds) / 3600;
      p.lat += (nm / 60) * Math.cos((p.track * Math.PI) / 180);
      p.lon +=
        (nm / 60) *
        (Math.sin((p.track * Math.PI) / 180) / Math.cos((p.lat * Math.PI) / 180));
      p.track = (p.track + 2) % 360; // gentle orbit
    }
    return {
      demo: true,
      now: Date.now(),
      ac: planes.map((p) => ({
        ...p,
        ownOp: 'Demo Air Arm (simulated)',
        alt_baro: 28000,
        alt_geom: 28500,
      })),
    };
  };
}
