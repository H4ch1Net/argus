import * as Cesium from 'cesium';

// Globe occlusion for point features (billboards, points, labels).
//
// Point markers are drawn with disableDepthTestDistance = Infinity so they stay
// crisp and never z-fight the surface they sit on. The cost of that is the depth
// buffer no longer hides the ones on the far side of the planet, so a marker in
// Hawaii would still show through the globe when Japan faces the camera.
//
// This culler restores correct front/back visibility geometrically instead of
// through the depth buffer: for the current camera position it asks an
// EllipsoidalOccluder whether each entity's world position is above the horizon,
// and toggles entity.show accordingly. It is orientation- and zoom-independent
// (a dot-product test against the horizon cone), so it holds from any camera.
//
// Line features (arcs, trails) are NOT handled here: they span the horizon, so a
// whole-entity show toggle is wrong for them. They rely on real depth testing
// against the globe instead (scene.globe.depthTestAgainstTerrain), which occludes
// exactly the portion behind the limb and lets the visible portion through.

/**
 * Is a world-space point visible over the horizon from a camera position?
 * Pure wrapper around Cesium's EllipsoidalOccluder, so the decision is unit
 * testable without a WebGL context. Altitude is accounted for (a high satellite
 * is visible farther around the limb than a point on the surface).
 * @param {Cesium.Cartesian3} cameraWC
 * @param {Cesium.Cartesian3} pointWC
 * @param {Cesium.Ellipsoid} [ellipsoid]
 * @returns {boolean}
 */
export function pointVisibleFromCamera(
  cameraWC,
  pointWC,
  ellipsoid = Cesium.Ellipsoid.WGS84,
) {
  const occluder = new Cesium.EllipsoidalOccluder(ellipsoid, cameraWC);
  return occluder.isPointVisible(pointWC);
}

// Graphics kinds that are single-anchor point features and should be horizon
// culled. Polylines/polygons are intentionally excluded (see file header).
function isPointFeature(entity) {
  return Boolean(entity.billboard || entity.point || entity.label);
}

/**
 * Attach horizon culling to a viewer. Runs on scene.postUpdate, which fires
 * exactly when the scene is going to render (camera moving, movers animating, or
 * a requested render after new data), so it is free when the scene is idle and
 * always current when it is not. Iterates every entity in every data source plus
 * the default collection, so layers added later are covered automatically.
 *
 * @param {import('cesium').Viewer} viewer
 * @returns {{ detach: () => void }}
 */
export function createOcclusionCuller(viewer) {
  const scene = viewer.scene;
  const occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    Cesium.Cartesian3.ZERO,
  );
  const scratch = new Cesium.Cartesian3();

  function cullCollection(entities, time) {
    const values = entities.values;
    for (let i = 0; i < values.length; i++) {
      const entity = values[i];
      if (!isPointFeature(entity) || !entity.position) continue;
      const pos = entity.position.getValue(time, scratch);
      if (!pos) continue;
      const visible = occluder.isPointVisible(pos);
      if (entity.show !== visible) entity.show = visible;
    }
  }

  function onPostUpdate(s, time) {
    // Update the occluder to the live camera position (setter recomputes the
    // horizon cone), then test every managed entity against it.
    occluder.cameraPosition = s.camera.positionWC;
    cullCollection(viewer.entities, time);
    const sources = viewer.dataSources;
    for (let i = 0; i < sources.length; i++) {
      cullCollection(sources.get(i).entities, time);
    }
  }

  const remove = scene.postUpdate.addEventListener(onPostUpdate);
  return {
    detach() {
      remove();
    },
  };
}
