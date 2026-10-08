import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireContinuousRender,
  releaseContinuousRender,
  animationFps,
} from './renderMode.js';

const sceneStub = () => {
  const s = {
    requestRenderMode: true,
    renders: 0,
    requestRender: () => (s.renders += 1),
  };
  return s;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('animation runs at the highest claimed rate until the last owner releases it', () => {
  const scene = sceneStub();
  acquireContinuousRender(scene, 30); // flights
  acquireContinuousRender(scene, 60); // cockpit
  assert.equal(animationFps(scene), 60);
  releaseContinuousRender(scene, 60);
  assert.equal(animationFps(scene), 30, 'flights still animating');
  releaseContinuousRender(scene, 30);
  assert.equal(animationFps(scene), 0, 'idle: no ticker');
  releaseContinuousRender(scene, 30); // a stray release never goes negative
  assert.equal(animationFps(scene), 0);
  assert.equal(scene.requestRenderMode, true, 'never switches to continuous rendering');
});

test('the ticker requests frames while claimed and stops after', async () => {
  const scene = sceneStub();
  acquireContinuousRender(scene, 100);
  await wait(60);
  releaseContinuousRender(scene, 100);
  const after = scene.renders;
  assert.ok(after >= 3, `requested ${after} frames`);
  await wait(40);
  assert.ok(scene.renders <= after + 1, 'no frames requested once idle');
});
