// Dev / demo-only cables: a few simulated great routes in TeleGeography's
// GeoJSON shape, so the cable layer works offline.

const ROUTES = [
  [
    'demo-atlantic',
    'Demo Atlantic (simulated)',
    '#4fc3f7',
    [
      [-74, 40.5],
      [-50, 44],
      [-20, 49],
      [-5, 50.2],
    ],
  ],
  [
    'demo-pacific',
    'Demo Pacific (simulated)',
    '#81c784',
    [
      [-122.5, 37.5],
      [-150, 30],
      [-175, 25],
      [150, 30],
      [139.8, 35],
    ],
  ],
  [
    'demo-indian',
    'Demo Indian Ocean (simulated)',
    '#ffb74d',
    [
      [32.5, 29.9],
      [43, 12.5],
      [60, 15],
      [72.8, 19],
    ],
  ],
];

export function createCableMockSource() {
  return async () => ({
    demo: true,
    type: 'FeatureCollection',
    features: ROUTES.map(([id, name, color, line]) => ({
      type: 'Feature',
      properties: { id, name, color },
      geometry: { type: 'MultiLineString', coordinates: [line] },
    })),
  });
}
