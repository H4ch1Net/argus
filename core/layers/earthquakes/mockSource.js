// Dev-only mock earthquake source: a fixed set of USGS-shaped features so the
// layer is demonstrable without a running proxy. Dev-gated + dynamic-imported,
// so it never ships in production.

const QUAKES = [
  { id: 'mq1', lon: -122.8, lat: 38.8, mag: 5.9, depth: 8, place: 'Northern California' },
  {
    id: 'mq2',
    lon: 140.5,
    lat: 37.4,
    mag: 6.7,
    depth: 35,
    place: 'off the coast of Honshu, Japan',
  },
  { id: 'mq3', lon: -70.7, lat: -33.4, mag: 4.3, depth: 60, place: 'Valparaiso, Chile' },
  { id: 'mq4', lon: 27.1, lat: 38.4, mag: 3.1, depth: 12, place: 'western Turkey' },
  { id: 'mq5', lon: -155.3, lat: 19.4, mag: 2.2, depth: 3, place: 'Island of Hawaii' },
  {
    id: 'mq6',
    lon: 95.9,
    lat: 3.3,
    mag: 7.4,
    depth: 25,
    place: 'northern Sumatra, Indonesia',
  },
  { id: 'mq7', lon: -117.0, lat: 34.1, mag: 1.4, depth: 6, place: 'Southern California' },
  { id: 'mq8', lon: 178.4, lat: -18.1, mag: 5.1, depth: 550, place: 'Fiji region' },
];

export function createQuakeMockSource() {
  return async () => ({
    type: 'FeatureCollection',
    features: QUAKES.map((q) => ({
      id: q.id,
      properties: { mag: q.mag, place: q.place, time: Date.now() - 3600_000, url: null },
      geometry: { type: 'Point', coordinates: [q.lon, q.lat, q.depth] },
    })),
  });
}
