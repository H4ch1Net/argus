import * as Cesium from 'cesium';

// Pick the entity nearest the screen centre (the reticle) with a generous box.
// Used by the mobile point-at-sky mode to "light up" whatever the phone points
// at. Reads the scene only; the shell owns the sensor and the reticle UI.

export function createCenterPicker(viewer) {
  const scene = viewer.scene;
  return {
    /** @returns {import('cesium').Entity | null} */
    pick() {
      const canvas = scene.canvas;
      const center = new Cesium.Cartesian2(
        canvas.clientWidth / 2,
        canvas.clientHeight / 2,
      );
      const picks = scene.drillPick(center, 5, 90, 90);
      for (const p of picks) {
        if (p && p.id instanceof Cesium.Entity) return p.id;
      }
      return null;
    },
  };
}
