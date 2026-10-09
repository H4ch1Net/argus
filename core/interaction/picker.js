import * as Cesium from 'cesium';
import { isTap, toleranceFor, createTapSequencer, MULTI_TAP_GAP_MS } from './gestures.js';
import { choosePick, entityPickClass, PICK_POINT } from './pickPriority.js';

// Taps on the globe, built on Pointer Events (the repo standard: one unified
// pointer stream, never separate mouse/touch/pen bindings). Drags and pinches
// fall through to Cesium's camera controls untouched; only taps act here.
//
// One tap selects what is under it at once (no wait for a possible second
// tap). Two taps zoom in about the tapped point, three zoom out; a tap on empty
// space deselects only once it is clear no second tap follows, so a double tap
// on the map keeps the current target. While a tool owns the taps (a route
// point, a drawing vertex) every tap goes to it and none of this applies.
// Taps the page synthesises (the Android Auto screen, via shell-car) are always
// single taps: the car has its own zoom gestures.
//
// Picking: touch taps get a fingertip-sized box (a billboard is a few pixels
// wide); contacts beat lines and lines beat areas under it (./pickPriority.js),
// and a contact behind the planet never counts.

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ onPick: (target: object | null, pos: {x:number,y:number}) => void,
 *   accept?: (target: object) => boolean,
 *   intercept?: (pos: {x:number,y:number}) => boolean,
 *   onZoom?: (factor: number, pos: {x:number,y:number}, opts: { chain: boolean }) => void }} opts
 *   accept: skip picks that are not contacts (the selection trail, sketch
 *   lines), so a contact further down the pick list still wins. A cluster
 *   marker is always accepted. intercept: a tool takes the tap (returns true).
 *   onZoom: double tap (factor 2) / triple tap (factor 0.5, chain: undo the
 *   double tap's zoom first); without it every tap is a single tap.
 */
export function createPicker(viewer, { onPick, accept, intercept, onZoom }) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const pointers = new Map(); // pointerId -> press { x, y, t, pointerType, trusted }
  let multi = false; // two or more pointers were down during this gesture
  const taps = createTapSequencer();
  let pendingEmpty = null; // a deferred "tapped nothing"

  const onPointerDown = (e) => {
    // A press whose release never arrived (lost outside the page) is forgotten.
    const now = performance.now();
    for (const [id, p] of pointers) if (now - p.t > 5000) pointers.delete(id);
    if (pointers.size === 0) multi = false;
    // Secondary buttons (right-drag zooms in Cesium) never select or zoom.
    if (e.button > 0) {
      multi = true;
      return;
    }
    pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      t: performance.now(),
      pointerType: e.pointerType,
      trusted: e.isTrusted !== false,
    });
    if (pointers.size > 1) multi = true;
  };

  const onPointerUp = (e) => {
    const start = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    if (!start || multi) return; // a pinch or a two-finger tap is never a pick
    const motion = {
      dx: e.clientX - start.x,
      dy: e.clientY - start.y,
      dtMs: performance.now() - start.t,
    };
    if (!isTap(motion, toleranceFor(start.pointerType))) return;
    const rect = canvas.getBoundingClientRect();
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    handleTap(pos, start);
  };

  function handleTap(pos, start) {
    if (intercept?.(pos)) {
      taps.reset();
      cancelEmpty();
      return;
    }
    const gestures = Boolean(onZoom) && start.trusted;
    const count = gestures
      ? taps.tap({
          t: performance.now(),
          x: pos.x,
          y: pos.y,
          pointerType: start.pointerType,
        })
      : 1;
    if (count === 2) {
      cancelEmpty(); // a double tap on the map keeps the current target
      onZoom(2, pos, { chain: false });
      return;
    }
    if (count === 3) {
      onZoom(0.5, pos, { chain: true });
      return;
    }
    const radius = toleranceFor(start.pointerType).pickRadiusPx;
    const target = pickAt(scene, pos, radius, accept);
    cancelEmpty();
    if (target || !gestures) {
      onPick(target, pos);
      return;
    }
    // Nothing here: deselect once no second tap can follow.
    pendingEmpty = setTimeout(() => {
      pendingEmpty = null;
      onPick(null, pos);
    }, MULTI_TAP_GAP_MS + 20);
  }

  function cancelEmpty() {
    if (pendingEmpty) clearTimeout(pendingEmpty);
    pendingEmpty = null;
  }

  // pointercancel (e.g. a gesture taken over by the browser) must reset, or the
  // next pointerup would measure motion against a stale press.
  const onPointerCancel = (e) => {
    pointers.delete(e.pointerId);
    multi = true;
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  return {
    destroy() {
      cancelEmpty();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
    },
  };
}

/**
 * What a pick result points at: a layer target (billboard layers set it as the
 * billboard's id), a cluster marker, or an Entity (line layers, query outputs).
 * Null otherwise.
 */
export function pickedTarget(p) {
  if (!p) return null;
  if (p.id?.argusTarget || p.id?.argusCluster) return p.id;
  // Line layers draw Entities; the layer hands back its target for them.
  if (p.id instanceof Cesium.Entity) return p.id._argusTarget ?? p.id;
  return null;
}

/** What kind of thing Cesium drew at the pick: 'point', 'model' or 'primitive'. */
function primitiveKind(prim) {
  if (!prim) return 'primitive';
  if (
    prim instanceof Cesium.Billboard ||
    prim instanceof Cesium.PointPrimitive ||
    prim instanceof Cesium.Label
  )
    return 'point';
  if (Cesium.Model && prim instanceof Cesium.Model) return 'model';
  return 'primitive';
}

const occluder = new Cesium.EllipsoidalOccluder(
  Cesium.Ellipsoid.WGS84,
  Cesium.Cartesian3.ZERO,
);

/** A drill-pick result as a pickPriority candidate, or null. */
function candidate(p, accept) {
  const target = pickedTarget(p);
  if (!target) return null;
  const kind = primitiveKind(p.primitive);
  const entity = p.id instanceof Cesium.Entity ? p.id : null;
  // Layer targets and cluster markers are contacts; Entities by what they draw.
  const cls = entity ? entityPickClass(entity, kind) : PICK_POINT;
  let occluded = false;
  if (kind === 'point' && !target.argusCluster) {
    // Glyphs draw without a depth test: check this one is on our side of the
    // planet (a cluster marker is made of contacts that are).
    const at = p.primitive.position;
    if (at && Number.isFinite(at.x)) occluded = !occluder.isPointVisible(at);
  }
  const accepted = target.argusCluster ? true : !accept || accept(target);
  return { target, cls, occluded, accepted };
}

/**
 * The target under a window position: drill-pick a box of radiusPx around it
 * and let ./pickPriority.js choose (contacts, then lines, then areas).
 */
export function pickAt(scene, windowPos, radiusPx, accept, limit = 12) {
  const size = Math.max(1, Math.round(radiusPx * 2));
  const at = new Cesium.Cartesian2(windowPos.x, windowPos.y);
  occluder.cameraPosition = scene.camera.positionWC;
  const picks = scene.drillPick(at, limit, size, size);
  return choosePick(picks.map((p) => candidate(p, accept)));
}

/** Kept for callers of the old name: the target under a tap, or null. */
export function pickEntity(scene, windowPos, radiusPx, accept) {
  return pickAt(scene, windowPos, radiusPx, accept);
}
