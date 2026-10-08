import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireContinuousRender, releaseContinuousRender } from './renderMode.js';

test('continuous rendering lasts until the last owner releases it', () => {
  const scene = { requestRenderMode: true, requestRender() {} };
  acquireContinuousRender(scene); // flights
  acquireContinuousRender(scene); // NVG shader
  releaseContinuousRender(scene); // flights off
  assert.equal(scene.requestRenderMode, false, 'shader still animating');
  releaseContinuousRender(scene); // NVG off
  assert.equal(scene.requestRenderMode, true, 'back to on-demand at idle');
  releaseContinuousRender(scene); // a stray release never goes negative
  acquireContinuousRender(scene);
  assert.equal(scene.requestRenderMode, false);
  releaseContinuousRender(scene);
  assert.equal(scene.requestRenderMode, true);
});
