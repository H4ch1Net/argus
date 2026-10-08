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
  // Glide parallel to the ground, so the altitude stays: along the camera's up
  // vector flattened onto the local horizontal (backwards for a point that is
  // too low). On a tilted view only |sin(pitch)| of that motion shifts the
  // picture, so the distance grows by its inverse.
  const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(
    camera.positionWC,
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Cartesian3.clone(camera.upWC, new Cesium.Cartesian3());
  const along = Cesium.Cartesian3.multiplyByScalar(
    normal,
    Cesium.Cartesian3.dot(up, normal),
    new Cesium.Cartesian3(),
  );
  const flat = Cesium.Cartesian3.subtract(up, along, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.magnitude(flat) < 1e-6) return;
  Cesium.Cartesian3.normalize(flat, flat);
  const sinPitch = Math.max(0.25, Math.abs(Math.sin(camera.pitch)));
  const perStep = -total / sinPitch / STEPS;
  let i = 0;
  const step = () => {
    camera.move(flat, perStep);
    scene.requestRender();
    if (++i < STEPS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
