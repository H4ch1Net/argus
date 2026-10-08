import * as Cesium from 'cesium';
import { isTap, toleranceFor } from './gestures.js';

// Entity picking on tap, built on Pointer Events (the repo standard: one unified
// pointer stream, never separate mouse/touch/pen bindings). We only act on taps;
// drags fall through to Cesium's camera controls untouched. Touch taps get a
// larger pick box because a fingertip covers far more than a few-pixel billboard
// (master plan 6.5).

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ onPick: (entity: import('cesium').Entity | null, pos: {x:number,y:number}) => void,
 *   accept?: (target: object) => boolean }} opts  accept: skip picks that are
 *   not contacts (the selection trail, sketch lines), so a contact further down
 *   the pick list still wins.
 */
export function createPicker(viewer, { onPick, accept }) {
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
    onPick(pickEntity(scene, windowPos, toleranceFor(pointerType).pickRadiusPx, accept), {
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

/**
 * What a pick result points at: a layer target (billboard layers set it as the
 * billboard's id) or an Entity (line layers, query outputs). Null otherwise.
 */
export function pickedTarget(p) {
  if (!p) return null;
  if (p.id?.argusTarget) return p.id;
  // Line layers draw Entities; the layer hands back its target for them.
  if (p.id instanceof Cesium.Entity) return p.id._argusTarget ?? p.id;
  return null;
}

/** Drill-pick a small box around the tap and return the nearest target, if any. */
export function pickEntity(scene, windowPos, radiusPx, accept) {
  const size = Math.max(1, radiusPx * 2);
  const picks = scene.drillPick(windowPos, 8, size, size);
  for (const p of picks) {
    const t = pickedTarget(p);
    if (t && (!accept || accept(t))) return t;
  }
  return null;
}
