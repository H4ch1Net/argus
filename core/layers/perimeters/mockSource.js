// Dev / demo-only fire perimeters: a WFIGS-shaped GeoJSON page with a few
// simulated incidents (one with an unburned island, one in two parts), so the
// layer works offline. Shapes are deterministic blobs, not real fires.

const INCIDENTS = [
  // [name, lon, lat, radius deg, acres, % contained, state, extras]
  ['DEMO RIDGE', -120.6, 39.4, 0.09, 18_400, 0, 'US-CA', { hole: true }],
  ['DEMO CANYON', -118.9, 34.6, 0.05, 6_200, 35, 'US-CA', {}],
  ['DEMO BUTTE', -121.9, 44.1, 0.06, 9_900, 80, 'US-OR', { split: true }],
  ['DEMO FLATS', -112.2, 33.9, 0.03, 1_150, 100, 'US-AZ', {}],
];

function blob(lon, lat, r, seed, n = 40) {
  const ring = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const k = 1 + 0.25 * Math.sin(a * 3 + seed) + 0.12 * Math.cos(a * 5 + seed * 2);
    return [
      Math.round((lon + Math.cos(a) * r * k * 1.3) * 1e4) / 1e4,
      Math.round((lat + Math.sin(a) * r * k) * 1e4) / 1e4,
    ];
  });
  return [...ring, ring[0]];
}

export function createPerimeterMockSource() {
  return async () => {
    const now = Date.now();
    const features = INCIDENTS.map(([name, lon, lat, r, acres, pct, state, x], i) => {
      const outer = blob(lon, lat, r, i + 1);
      const geometry = x.split
        ? {
            type: 'MultiPolygon',
            coordinates: [[outer], [blob(lon + r * 3, lat - r, r * 0.4, i + 7)]],
          }
        : {
            type: 'Polygon',
            coordinates: x.hole
              ? [outer, blob(lon, lat, r * 0.25, i + 3, 12).reverse()]
              : [outer],
          };
      return {
        type: 'Feature',
        id: i + 1,
        properties: {
          poly_IncidentName: name,
          attr_UniqueFireIdentifier: `2026-DEMO-${String(i + 1).padStart(6, '0')}`,
          attr_IncidentSize: acres,
          attr_PercentContained: pct,
          attr_POOState: state,
          attr_IncidentTypeCategory: 'WF',
          attr_FireDiscoveryDateTime: now - (i + 2) * 86_400_000,
          poly_DateCurrent: now - (i + 1) * 3_600_000,
          attr_FireCause: i % 2 ? 'Human' : 'Natural',
          attr_FireBehaviorGeneral: pct >= 100 ? 'Minimal' : 'Active',
          attr_TotalIncidentPersonnel: 120 + i * 85,
          attr_POOCounty: 'Demo',
          attr_EstimatedCostToDate: 250_000 * (i + 1) ** 2,
          attr_IncidentComplexityLevel: i === 0 ? 'Type 1 Incident' : 'Type 3 Incident',
          attr_CpxName: null,
        },
        geometry,
      };
    });
    return { type: 'FeatureCollection', demo: true, features };
  };
}
