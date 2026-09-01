import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { pointVisibleFromCamera } from './occlusion.js';

// Horizon visibility is what keeps far-side markers from showing through the
// globe. These assert the geometric decision from a known camera, no WebGL.

const R = Cesium.Ellipsoid.WGS84.maximumRadius;

test('a point on the near side of the globe is visible', () => {
  // Camera far out over the North pole; the North pole faces it.
  const camera = new Cesium.Cartesian3(0, 0, R * 4);
  const northPole = new Cesium.Cartesian3(0, 0, R);
  assert.equal(pointVisibleFromCamera(camera, northPole), true);
});

test('a point on the far side of the globe is occluded', () => {
  // Same camera over the North pole; the South pole is behind the planet.
  const camera = new Cesium.Cartesian3(0, 0, R * 4);
  const southPole = new Cesium.Cartesian3(0, 0, -R);
  assert.equal(pointVisibleFromCamera(camera, southPole), false);
});

test('a point on the limb tilts out of view as the camera rotates past it', () => {
  const camera = new Cesium.Cartesian3(0, 0, R * 4); // over the North pole
  // A point on the equator at lon 0 sits on the limb; nudge it to the far
  // hemisphere (below the equator, away from camera) and it must be occluded.
  const equatorFar = Cesium.Cartesian3.fromDegrees(0, -20, 0);
  assert.equal(pointVisibleFromCamera(camera, equatorFar), false);
  // The same latitude on the near-facing side stays visible.
  const equatorNear = Cesium.Cartesian3.fromDegrees(0, 20, 0);
  assert.equal(pointVisibleFromCamera(camera, equatorNear), true);
});

test('altitude lets a high point peek over the horizon', () => {
  const camera = new Cesium.Cartesian3(0, 0, R * 6);
  // A ground point just past the limb is hidden, but the same lon/lat at high
  // altitude (a satellite) clears the horizon and is visible.
  const groundPastLimb = Cesium.Cartesian3.fromDegrees(0, -8, 0);
  const highPastLimb = Cesium.Cartesian3.fromDegrees(0, -8, 2_000_000);
  assert.equal(pointVisibleFromCamera(camera, groundPastLimb), false);
  assert.equal(pointVisibleFromCamera(camera, highPastLimb), true);
});
