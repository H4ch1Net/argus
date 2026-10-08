import * as Cesium from 'cesium';

// Keep a point in the part of the screen the user can actually see. On the
// phone the target card slides up over the lower half, so a contact tapped low
// on the screen would end up under it: this glides the camera sideways (never
// in or out) until the point sits in the free area above the sheet. Nothing
// happens when the point is already in view.

const STEPS = 18;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {import('cesium').Cartesian3} position
 * @param {{ top?: number, bottom?: number }} free px reserved at the top/bottom
 */
export function nudgeIntoView(viewer, position, { top = 0, bottom = 0 } = {}) {
  const scene = viewer.scene;
  const camera = viewer.camera;
  if (!position || viewer.trackedEntity) return;
  const win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, position);
  if (!win) return;
  const h = scene.canvas.clientHeight;
  const lo = top + 30;
  const hi = h - bottom - 40;
  if (win.y >= lo && win.y <= hi) return;
  const want = top + (h - top - bottom) * 0.45;
  const dist = Cesium.Cartesian3.distance(camera.positionWC, position);
  const fovy = camera.frustum.fovy ?? camera.frustum.fov ?? Math.PI / 3;
  const metresPerPx = (2 * dist * Math.tan(fovy / 2)) / h;
  const total = (win.y - want) * metresPerPx; // > 0: the point is too low
  let i = 0;
  const step = () => {
    camera.moveDown(total / STEPS);
    scene.requestRender();
    if (++i < STEPS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
