import { pickAt } from './picker.js';

// Pick the entity nearest the screen centre (the reticle) with a generous box.
// Used by the mobile point-at-sky mode to "light up" whatever the phone points
// at. Reads the scene only; the shell owns the sensor and the reticle UI. The
// same priority as a tap: contacts before lines before areas, nothing behind
// the planet.

export function createCenterPicker(viewer, { accept } = {}) {
  const scene = viewer.scene;
  return {
    /** @returns {object | null} a layer target or Entity */
    pick() {
      const canvas = scene.canvas;
      const target = pickAt(
        scene,
        { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 },
        45,
        accept,
        6,
      );
      // A cluster marker is not something to light up.
      return target?.argusCluster ? null : target;
    },
  };
}
