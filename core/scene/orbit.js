import * as Cesium from 'cesium';
import { acquireContinuousRender, releaseContinuousRender } from './renderMode.js';

// Orbit: the camera circles the ground point in the middle of the view (or a
// given point), keeping its range and pitch, at a steady 6 degrees a second.
// Any press on the globe, a wheel turn or Escape stops it; callers stop it
// before flying the camera elsewhere. Frames are claimed from the shared pacer
// only while it turns. Adapted from gods-eye-view's orbit controller (src/camera.js, MIT).

const DEG_PER_S = 6;
const PITCH_MIN = Cesium.Math.toRadians(-80);
const PITCH_MAX = Cesium.Math.toRadians(-12);

/** @param {import('cesium').Viewer} viewer */
export function createOrbit(viewer, { fps = 30, onChange, isBusy } = {}) {
  const scene = viewer.scene;
  const camera = viewer.camera;
  let active = false;
  let center = null;
  let hpr = null;
  let last = 0;
  let removePre = null;

  function centerPoint() {
    const c = scene.canvas;
    const p = camera.pickEllipsoid?.(
      new Cesium.Cartesian2(c.clientWidth / 2, c.clientHeight / 2),
      scene.globe?.ellipsoid ?? Cesium.Ellipsoid.WGS84,
    );
    return p ?? null;
  }

  function tick() {
    if (!active) return;
    // Something else took the camera (FOLLOW, the cockpit): let it.
    if (viewer.trackedEntity || isBusy?.()) {
      stop();
      return;
    }
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    hpr.heading = Cesium.Math.zeroToTwoPi(
      hpr.heading + Cesium.Math.toRadians(DEG_PER_S) * dt,
    );
    camera.lookAt(center, hpr);
  }

  const stopOnInput = () => stop();
  const onKey = (e) => e.key === 'Escape' && stop();

  function start(point) {
    if (active) stop();
    center = point ?? centerPoint();
    if (!center) return false;
    const range = Cesium.Cartesian3.distance(camera.positionWC, center);
    if (!Number.isFinite(range) || range <= 0) return false;
    // Seen from the centre: the camera's heading stays, the pitch is clamped
    // to a view that shows the ground around the point.
    hpr = new Cesium.HeadingPitchRange(
      camera.heading,
      Cesium.Math.clamp(camera.pitch, PITCH_MIN, PITCH_MAX),
      Math.min(range, 2_000_000),
    );
    active = true;
    last = performance.now();
    removePre = scene.preRender.addEventListener(tick);
    acquireContinuousRender(scene, fps);
    scene.canvas.addEventListener('pointerdown', stopOnInput);
    scene.canvas.addEventListener('wheel', stopOnInput, { passive: true });
    document.addEventListener('keydown', onKey);
    onChange?.(true);
    return true;
  }

  function stop() {
    if (!active) return;
    active = false;
    removePre?.();
    removePre = null;
    releaseContinuousRender(scene, fps);
    scene.canvas.removeEventListener('pointerdown', stopOnInput);
    scene.canvas.removeEventListener('wheel', stopOnInput);
    document.removeEventListener('keydown', onKey);
    // Hand the camera back to the normal controls, where it is now.
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    scene.requestRender();
    onChange?.(false);
  }

  return {
    start,
    stop,
    toggle: () => (active ? (stop(), false) : start()),
    active: () => active,
    destroy: stop,
  };
}
