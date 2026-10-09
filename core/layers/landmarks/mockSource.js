// Dev-only mock landmarks: Overpass-shaped nodes around a point or within the
// current view, some with a Wikidata link, so the layer and the NEARBY list are
// demonstrable without a proxy. Dev-gated + dynamic-imported.

import { computeViewportQuery } from '../sdk/viewport.js';

const rand = (a, b) => a + Math.random() * (b - a);
const KINDS = [
  { tourism: 'attraction', name: 'Overlook', wikidata: 'Q1' },
  { tourism: 'museum', name: 'City Museum', wikidata: 'Q2' },
  { historic: 'monument', name: 'Old Monument' },
  { tourism: 'viewpoint', name: 'Scenic Viewpoint' },
  { historic: 'castle', name: 'Hillside Castle', wikipedia: 'en:Hillside Castle' },
  { man_made: 'tower', name: 'Radio Tower', height: '120' },
  { man_made: 'lighthouse', name: 'Harbour Light' },
];

function elementsIn(b, count) {
  return Array.from({ length: count }, (_, i) => {
    const k = KINDS[i % KINDS.length];
    return {
      type: 'node',
      id: 2_000_000 + i,
      lat: rand(b.lamin, b.lamax),
      lon: rand(b.lomin, b.lomax),
      tags: { ...k, name: `${k.name} ${i}` },
    };
  });
}

export function createLandmarkMockSource({ viewer, count = 20 }) {
  return async () => ({ elements: elementsIn(computeViewportQuery(viewer).bbox, count) });
}

/** For TOOLS > LANDMARKS without a proxy: landmarks within radiusKm of a point. */
export function mockLandmarksAround({ lat, lon }, radiusKm = 5, count = 24) {
  const dLat = radiusKm / 111;
  const dLon = radiusKm / (111 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return {
    elements: elementsIn(
      { lamin: lat - dLat, lamax: lat + dLat, lomin: lon - dLon, lomax: lon + dLon },
      count,
    ),
  };
}
