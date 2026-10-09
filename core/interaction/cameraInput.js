import * as Cesium from 'cesium';
import { pinchZoomFactor, wheelPinchFactor } from './gestures.js';

// Camera input tuning for every shell (Pointer Events only). Cesium's camera
// controller does the dragging, tilting and wheel zoom; this makes its zoom
// gestures feel like a map app's:
//
// - Two-finger pinch tracks the fingers. Cesium zooms by a fixed factor of the
//   change in finger spacing, about a third of what the fingers did on a
//   phone, which reads as lag. While two touches are down, its zoom factor is
//   set from their spacing so each frame moves the camera by exactly as much as
//   the spacing changed (gestures.js pinchZoomFactor); the wheel keeps the
//   default.
// - A trackpad pinch (a wheel event with ctrlKey) zooms about the cursor by the
//   scale the trackpad reports, instead of zooming the whole page (Cesium binds
//   no action to ctrl+wheel, so the browser did).
// - The camera keeps a sane envelope: not closer than 20 m to the ground, not
//   further out than 45,000 km.
// - Cesium's own click handlers go: a click picked the scene a second time and
//   asked imagery providers for features, and a double click locked the camera
//   onto whatever Entity was under it (taps are core/interaction/picker.js).

const MIN_ZOOM_M = 20;
const MAX_ZOOM_M = 4.5e7;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ zoomAt?: (pos: {x:number,y:number}, factor: number, opts?: object) => void }} [camera]
 *   the camera controls (core/scene/cameraControls.js), for the trackpad pinch
 */
export function tuneCameraInput(viewer, camera) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const sscc = scene.screenSpaceCameraController;
  const baseZoomFactor = sscc.zoomFactor ?? 5;
  sscc.minimumZoomDistance = MIN_ZOOM_M;
  sscc.maximumZoomDistance = MAX_ZOOM_M;

  const handler = viewer.screenSpaceEventHandler;
  const types = Cesium.ScreenSpaceEventType ?? {};
  for (const t of [types.LEFT_CLICK, types.LEFT_DOUBLE_CLICK]) {
    if (t !== undefined) handler?.removeInputAction?.(t);
  }

  // --- touch pinch -------------------------------------------------------------
  const touches = new Map(); // pointerId -> { x, y }
  function spacing() {
    const [a, b] = touches.values();
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  function retune() {
    sscc.zoomFactor =
      touches.size === 2
        ? pinchZoomFactor(spacing(), canvas.clientHeight || 1)
        : baseZoomFactor;
  }
  const onDown = (e) => {
    if (e.pointerType !== 'touch' || !e.isTrusted) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    retune();
  };
  const onMove = (e) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    t.x = e.clientX;
    t.y = e.clientY;
    if (touches.size === 2) retune();
  };
  const onUp = (e) => {
    if (!touches.delete(e.pointerId)) return;
    retune();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // --- trackpad pinch (ctrl+wheel) ---------------------------------------------
  // Caught on the canvas' parent in the capture phase, so Cesium never sees it.
  const host = canvas.parentElement;
  const onWheel = (e) => {
    if (!e.ctrlKey || e.target !== canvas || !camera?.zoomAt) return;
    if (!sscc.enableInputs || !sscc.enableZoom) return;
    e.preventDefault();
    e.stopPropagation();
    const r = canvas.getBoundingClientRect();
    camera.zoomAt(
      { x: e.clientX - r.left, y: e.clientY - r.top },
      wheelPinchFactor(e.deltaY, e.deltaMode),
      { duration: 0 },
    );
  };
  host?.addEventListener('wheel', onWheel, { capture: true, passive: false });

  return {
    destroy() {
      sscc.zoomFactor = baseZoomFactor;
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      host?.removeEventListener('wheel', onWheel, { capture: true });
    },
  };
}
