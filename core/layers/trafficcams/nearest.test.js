import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestCamera, haversineKm } from './nearest.js';

const cams = [
  { id: 'tfl-a', lat: 51.5, lon: -0.12 },
  { id: 'tfl-b', lat: 51.52, lon: -0.1 },
  { id: 'bad', lat: 'x', lon: 0 },
  { id: 'ent', position: { latitude: 51.507, longitude: -0.128 } },
];

test('picks the closest camera by great-circle distance', () => {
  const hit = nearestCamera(cams, { lat: 51.5074, lon: -0.1278 });
  assert.equal(hit.camera.id, 'ent');
  assert.equal(hit.index, 3);
  assert.ok(hit.distanceKm < 0.1);
  assert.equal(nearestCamera(cams, { lat: 51.53, lon: -0.1 }).camera.id, 'tfl-b');
});

test('respects maxKm and refuses bad input', () => {
  assert.equal(nearestCamera(cams, { lat: 40.7, lon: -74 }, { maxKm: 50 }), null);
  assert.equal(nearestCamera(cams, { lat: 95, lon: 0 }), null);
  assert.equal(nearestCamera(null, { lat: 0, lon: 0 }), null);
  assert.equal(nearestCamera([], { lat: 0, lon: 0 }), null);
  assert.ok(Math.abs(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.2) < 0.1);
  // Across the antimeridian the short way round wins.
  const seam = [
    { id: 'east', lat: 0, lon: 179.9 },
    { id: 'west', lat: 0, lon: -170 },
  ];
  assert.equal(nearestCamera(seam, { lat: 0, lon: -179.9 }).camera.id, 'east');
});
