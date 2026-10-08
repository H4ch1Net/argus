import * as Cesium from 'cesium';
import {
  acquireContinuousRender,
  releaseContinuousRender,
} from '../../scene/renderMode.js';
import { sampleWind } from './field.js';

// Wind streaks: particles seeded over the field, advected by the sampled wind
// in geographic space, drawn as fading trails on a 2D canvas over the globe.
// Grey for light air, brighter with speed, white above 15 m/s (ctOS: no
// rainbow ramp). Particle counts per tier (full 1800, balanced 700, minimal
// 300); it animates only while visible, at the shared pacer's rate. Trails
// clear while the camera moves so streaks never smear across a pan. Adapted
// from gods-eye-view's canvas 2D wind fallback (src/layers/wind/rendering.js,
// MIT).

const COUNT = { full: 1800, balanced: 700, minimal: 300 };
const MAX_AGE = 90; // frames
const FADE = 0.9; // trail alpha kept per frame
const SPEED_STEPS = [
  [3, 'rgba(122,122,122,0.55)'],
  [7, 'rgba(195,195,195,0.7)'],
  [15, 'rgba(217,217,217,0.85)'],
  [Infinity, 'rgba(255,255,255,0.95)'],
];

/** @param {import('cesium').Viewer} viewer */
export function createWindRenderer(viewer, { fps = 30 } = {}) {
  const tier = fps >= 30 ? 'full' : fps >= 20 ? 'balanced' : 'minimal';
  const scene = viewer.scene;
  const host = viewer.container ?? scene.canvas.parentElement;
  const canvas = document.createElement('canvas');
  canvas.className = 'argus-overlay argus-wind';
  canvas.setAttribute('aria-hidden', 'true');
  // Under the tracking overlay, so boxes and labels stay on top of the streaks.
  host.insertBefore(canvas, host.querySelector('.argus-overlay'));
  const g = canvas.getContext('2d');
  const n = COUNT[tier] ?? COUNT.balanced;
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const age = new Uint16Array(n);
  const sx = new Float32Array(n);
  const sy = new Float32Array(n);
  let field = null;
  let visible = false;
  let claimed = false;
  let w = 0;
  let h = 0;
  let dpr = 1;
  const occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    Cesium.Cartesian3.ZERO,
  );
  const scratch = new Cesium.Cartesian3();
  const win = new Cesium.Cartesian2();
  let lastCam = new Cesium.Cartesian3();

  function resize() {
    const r = host.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = r.width;
    h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  function seed(i) {
    if (!field) return;
    lon[i] = field.west + Math.random() * (field.east - field.west);
    lat[i] = field.south + Math.random() * (field.north - field.south);
    if (lon[i] > 180) lon[i] -= 360;
    age[i] = Math.floor(Math.random() * MAX_AGE);
    sx[i] = NaN;
  }

  function project(i) {
    const p = Cesium.Cartesian3.fromDegrees(
      lon[i],
      lat[i],
      0,
      Cesium.Ellipsoid.WGS84,
      scratch,
    );
    if (!occluder.isPointVisible(p)) return null;
    return Cesium.SceneTransforms.worldToWindowCoordinates(scene, p, win);
  }

  function draw() {
    if (!visible || !field) return;
    const cam = scene.camera.positionWC;
    const moved = !Cesium.Cartesian3.equalsEpsilon(cam, lastCam, 0, 1);
    lastCam = Cesium.Cartesian3.clone(cam, lastCam);
    occluder.cameraPosition = cam;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (moved) {
      g.clearRect(0, 0, w, h);
      sx.fill(NaN);
    } else {
      // Fade the previous frame's trails.
      g.globalCompositeOperation = 'destination-in';
      g.fillStyle = `rgba(0,0,0,${FADE})`;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    }
    // Move about 1/700 of the view per frame at 10 m/s, whatever the zoom.
    const height = scene.camera.positionCartographic.height;
    const metresPerStep = Math.max(20, height / 700) / 10;
    g.lineWidth = 1.2;
    const paths = SPEED_STEPS.map(() => new Path2D());
    for (let i = 0; i < n; i += 1) {
      age[i] += 1;
      const s = sampleWind(field, lon[i], lat[i]);
      if (!s || age[i] > MAX_AGE || s.speed < 0.2) {
        seed(i);
        continue;
      }
      const cosLat = Math.max(0.2, Math.cos((lat[i] * Math.PI) / 180));
      lon[i] += (s.u * metresPerStep) / (111_320 * cosLat);
      lat[i] += (s.v * metresPerStep) / 110_540;
      const p = project(i);
      if (!p) {
        sx[i] = NaN;
        continue;
      }
      if (Number.isFinite(sx[i]) && Math.abs(p.x - sx[i]) + Math.abs(p.y - sy[i]) < 40) {
        const k = SPEED_STEPS.findIndex(([max]) => s.speed < max);
        paths[k].moveTo(sx[i], sy[i]);
        paths[k].lineTo(p.x, p.y);
      }
      sx[i] = p.x;
      sy[i] = p.y;
    }
    SPEED_STEPS.forEach(([, color], k) => {
      g.strokeStyle = color;
      g.stroke(paths[k]);
    });
  }

  const removePost = scene.postRender.addEventListener(draw);

  function setClaim(on) {
    if (on === claimed) return;
    claimed = on;
    if (on) acquireContinuousRender(scene, fps);
    else releaseContinuousRender(scene, fps);
  }

  return {
    setField(f) {
      field = f;
      for (let i = 0; i < n; i += 1) seed(i);
      g.clearRect(0, 0, canvas.width, canvas.height);
      setClaim(visible && Boolean(field));
      scene.requestRender();
    },
    setVisible(on) {
      visible = Boolean(on);
      canvas.hidden = !visible;
      if (!visible) g.clearRect(0, 0, canvas.width, canvas.height);
      setClaim(visible && Boolean(field));
    },
    destroy() {
      setClaim(false);
      removePost();
      ro.disconnect();
      canvas.remove();
    },
  };
}
