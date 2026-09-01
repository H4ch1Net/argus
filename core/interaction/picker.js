import * as Cesium from 'cesium';
import { isTap, toleranceFor } from './gestures.js';

// Entity picking on tap, built on Pointer Events (the repo standard: one unified
// pointer stream, never separate mouse/touch/pen bindings). We only act on taps;
// drags fall through to Cesium's camera controls untouched. Touch taps get a
// larger pick box because a fingertip covers far more than a few-pixel billboard
// (master plan 6.5).

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ onPick: (entity: import('cesium').Entity | null, pos: {x:number,y:number}) => void }} opts
 */
export function createPicker(viewer, { onPick }) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  let start = null;

  const onPointerDown = (e) => {
    start = {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      pointerType: e.pointerType,
    };
  };

  const onPointerUp = (e) => {
    if (!start) return;
    const motion = {
      dx: e.clientX - start.x,
      dy: e.clientY - start.y,
      dtMs: performance.now() - start.t,
    };
    const tol = toleranceFor(start.pointerType);
    const wasTap = isTap(motion, tol);
    const pointerType = start.pointerType;
    start = null;
    if (!wasTap) return;

    const rect = canvas.getBoundingClientRect();
    const windowPos = new Cesium.Cartesian2(e.clientX - rect.left, e.clientY - rect.top);
    onPick(pickEntity(scene, windowPos, toleranceFor(pointerType).pickRadiusPx), {
      x: windowPos.x,
      y: windowPos.y,
    });
  };

  // pointercancel (e.g. gesture taken over by the browser) must reset, or the
  // next pointerup would measure motion against a stale press.
  const onPointerCancel = () => {
    start = null;
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  return {
    destroy() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
    },
  };
}

/** Drill-pick a small box around the tap and return the nearest entity, if any. */
function pickEntity(scene, windowPos, radiusPx) {
  const size = Math.max(1, radiusPx * 2);
  const picks = scene.drillPick(windowPos, 8, size, size);
  for (const p of picks) {
    if (p && p.id instanceof Cesium.Entity) return p.id;
  }
  return null;
}
