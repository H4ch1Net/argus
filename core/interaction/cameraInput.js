import * as Cesium from 'cesium';
import { wheelPinchFactor } from './gestures.js';
import {
  createTwoFingerRecognizer,
  createTouchTracker,
  createInertia,
  tiltPerPx,
} from './twoFinger.js';
import { CAMERA_MIN_HEIGHT_M, CAMERA_MAX_HEIGHT_M } from '../scene/cameraControls.js';

// Camera input tuning for every shell (Pointer Events only). Cesium's camera
// controller keeps the mouse, the wheel and the one-finger drag; this adds:
//
// - Two-finger touch gestures, recognised here instead of by Cesium. Cesium's
//   pinch zooms, twists and tilts all at once from the same two fingers, so
//   they fight (a pinch also turns and tips the map), and its twist reads the
//   raw finger angle, which jumps a whole turn when the fingers pass level.
//   Its pinch is taken away (CameraEventType.PINCH) and ./twoFinger.js decides
//   between pinch, twist and tilt with dead zones; the camera moves about the
//   ground under the fingers, once per rendered frame, smoothed, with a short
//   glide after a fling. Palms, a stray second finger during a pan and the
//   edge strips are handled there too (see createTouchTracker).
// - A trackpad pinch (a wheel event with ctrlKey) zooms about the cursor by the
//   scale the trackpad reports, instead of zooming the whole page (Cesium binds
//   no action to ctrl+wheel, so the browser did).
// - The camera keeps a sane envelope: not closer than 20 m to the ground, not
//   further out than 45,000 km.
// - Cesium's own click handlers go: a click picked the scene a second time and
//   asked imagery providers for features, and a double click locked the camera
//   onto whatever Entity was under it (taps are core/interaction/picker.js).
// - While fingers are on the map (and while a glide runs) the frame cap is
//   lifted to 60 fps, then put back: a phone idles at 30, which made every
//   drag and pinch visibly step.

// The frame cap while touch gestures move the camera.
const GESTURE_FPS = 60;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {object} [camera]  the camera controls (core/scene/cameraControls.js):
 *   zoomAt for the trackpad pinch; pivotAt, zoomAbout, rotateAbout, tiltAbout
 *   and beginGesture for the touch gestures (without them Cesium keeps its own)
 */
export function tuneCameraInput(viewer, camera) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const sscc = scene.screenSpaceCameraController;
  sscc.minimumZoomDistance = CAMERA_MIN_HEIGHT_M;
  sscc.maximumZoomDistance = CAMERA_MAX_HEIGHT_M;

  const handler = viewer.screenSpaceEventHandler;
  const types = Cesium.ScreenSpaceEventType ?? {};
  for (const t of [types.LEFT_CLICK, types.LEFT_DOUBLE_CLICK]) {
    if (t !== undefined) handler?.removeInputAction?.(t);
  }

  const touch = camera?.zoomAbout ? attachTouchGestures(viewer, camera) : null;

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
      touch?.destroy();
      host?.removeEventListener('wheel', onWheel, { capture: true });
    },
  };
}

// Cesium's controller state that carries a drag's or a zoom's glide (1.140).
const CESIUM_INERTIA = [
  '_lastInertiaSpinMovement',
  '_lastInertiaTranslateMovement',
  '_lastInertiaZoomMovement',
  '_lastInertiaTiltMovement',
];
const EVENT_TYPE_KEYS = [
  'zoomEventTypes',
  'tiltEventTypes',
  'rotateEventTypes',
  'translateEventTypes',
  'lookEventTypes',
];

/** An event-type setting (one type, a {eventType, modifier}, or a list) without one type. */
function withoutType(types, drop) {
  if (types === undefined || types === null) return types;
  const list = Array.isArray(types) ? types : [types];
  const kept = list.filter((t) => (t?.eventType ?? t) !== drop);
  if (kept.length === list.length) return types;
  return Array.isArray(types) ? kept : kept[0];
}

/**
 * Two-finger touch gestures (pointerType 'touch' only; the mouse, pen,
 * trackpad and wheel stay Cesium's). One finger still pans through Cesium.
 */
function attachTouchGestures(viewer, camera) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const sscc = scene.screenSpaceCameraController;
  const host = canvas.parentElement;
  if (!host) return null;

  // Take the two-finger pinch (zoom + twist + tilt) away from Cesium.
  const pinch = Cesium.CameraEventType?.PINCH;
  const savedTypes = {};
  if (pinch !== undefined) {
    for (const key of EVENT_TYPE_KEYS) {
      if (!(key in sscc)) continue;
      savedTypes[key] = sscc[key];
      sscc[key] = withoutType(sscc[key], pinch);
    }
  }
  // A one-finger drag that a second finger interrupts would otherwise keep
  // gliding under the pinch (Cesium ends the drag there and flings it). Its
  // next drag turns the glide back on. A state Cesium has not made yet (no
  // frame since boot) is made here, already off.
  const stopCesiumGlide = () => {
    for (const key of CESIUM_INERTIA) {
      const m = sscc[key];
      if (m && typeof m === 'object') {
        m.inertiaEnabled = false;
      } else if (m === undefined && key in sscc && Cesium.Cartesian2) {
        sscc[key] = {
          startPosition: new Cesium.Cartesian2(),
          endPosition: new Cesium.Cartesian2(),
          motion: new Cesium.Cartesian2(),
          inertiaEnabled: false,
        };
      }
    }
  };

  const tracker = createTouchTracker();
  const rec = createTwoFingerRecognizer();
  let began = false; // this gesture has moved the camera
  let tiltPivot = null;
  let lastMid = null;
  let glide = null; // { inertia, pivot, t }
  let boosted = null; // the frame cap before the boost
  let restoreCap = null; // a boost to undo once the cockpit hands inputs back

  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const inputsOn = () => sscc.enableInputs !== false;

  // --- frame cap ---------------------------------------------------------------
  function boost() {
    const cap = viewer.targetFrameRate;
    if (boosted !== null || !(cap > 0) || cap >= GESTURE_FPS || !inputsOn()) return;
    boosted = cap;
    // The thermal ladder (core/scene/thermal.js) keeps judging frames against
    // the ambient cap: a gesture at 60 is a short burst, not a sign of heat.
    viewer.argusBudgetFps = cap;
    viewer.targetFrameRate = GESTURE_FPS;
  }
  function unboost() {
    if (boosted === null || tracker.size > 0 || glide) return;
    // The cockpit holds the inputs (and its own cap): undo ours once it is done.
    if (inputsOn()) {
      if (viewer.targetFrameRate === GESTURE_FPS) viewer.targetFrameRate = boosted;
    } else {
      restoreCap = boosted;
    }
    boosted = null;
    delete viewer.argusBudgetFps;
  }

  // --- the gesture ---------------------------------------------------------------
  function beginPair() {
    const [a, b] = tracker.pair;
    const edge = a.edge || b.edge;
    rec.begin(a, b, performance.now(), { noRotate: edge, noTilt: edge });
    began = false;
    tiltPivot = null;
    lastMid = null;
    stopCesiumGlide();
    scene.requestRender();
  }

  function applyGesture() {
    const pair = tracker.pair;
    if (!pair || !rec.active) return;
    const out = rec.update(pair[0], pair[1], performance.now());
    lastMid = out.mid;
    if (out.settling) scene.requestRender();
    if (!out.changed || !inputsOn()) return;
    if (!began) {
      began = true;
      camera.beginGesture?.();
    }
    if (out.tilt) {
      if (sscc.enableTilt === false) return;
      tiltPivot ??=
        camera.pivotAt({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }) ??
        camera.pivotAt(out.mid);
      // Fingers up (negative) tip the view toward the horizon.
      camera.tiltAbout(tiltPivot, -out.tilt * tiltPerPx(canvas.clientHeight));
      return;
    }
    // Cesium's own twist belonged to its tilt, so enableTilt governs both.
    const pivot = camera.pivotAt(out.mid);
    if (out.rotate && sscc.enableTilt !== false) camera.rotateAbout(pivot, out.rotate);
    if (out.zoom !== 1 && sscc.enableZoom !== false) camera.zoomAbout(pivot, out.zoom);
  }

  function endPair(fling) {
    applyGesture(); // what moved since the last frame
    const speed = rec.end(performance.now());
    if (!fling || !began || !inputsOn()) return;
    const inertia = createInertia(speed);
    if (inertia.done) return;
    glide = {
      inertia,
      pivot: lastMid ? camera.pivotAt(lastMid) : undefined,
      t: performance.now(),
    };
    scene.requestRender();
  }

  function stepGlide() {
    const now = performance.now();
    const s = glide.inertia.step(Math.min(64, now - glide.t));
    glide.t = now;
    if (s.rotate && glide.pivot) camera.rotateAbout(glide.pivot, s.rotate);
    if (s.zoom !== 1 && camera.zoomAbout(glide.pivot, s.zoom) === 1) glide.inertia = null;
    if (!glide.inertia || glide.inertia.done) stopGlide();
    else scene.requestRender();
  }

  function stopGlide() {
    if (!glide) return;
    glide = null;
    unboost();
  }

  // Once per rendered frame: the camera moves just before Cesium draws it.
  const removePreRender = scene.preRender.addEventListener(() => {
    if (restoreCap !== null && inputsOn()) {
      if (viewer.targetFrameRate === GESTURE_FPS) viewer.targetFrameRate = restoreCap;
      restoreCap = null;
    }
    if (tracker.pair) applyGesture();
    else if (glide && inputsOn()) stepGlide();
    else if (glide) stopGlide();
  });

  // --- pointers ------------------------------------------------------------------
  // Listened for on the canvas' parent in the capture phase: a palm or a stray
  // finger is stopped there, so neither Cesium nor the picker ever sees it.
  const onDown = (e) => {
    if (e.pointerType !== 'touch' || !e.isTrusted || e.target !== canvas) return;
    const p = local(e);
    const r = tracker.down({
      id: e.pointerId,
      x: p.x,
      y: p.y,
      viewportX: e.clientX,
      viewportWidth: window.innerWidth,
      width: e.width,
      height: e.height,
      t: performance.now(),
    });
    if (r.ignore) {
      e.stopPropagation();
      return;
    }
    boost();
    if (r.started) beginPair();
  };
  const onMove = (e) => {
    if (e.pointerType !== 'touch' || !tracker.has(e.pointerId)) return;
    const p = local(e);
    const r = tracker.move({
      id: e.pointerId,
      x: p.x,
      y: p.y,
      width: e.width,
      height: e.height,
      t: performance.now(),
    });
    if (r.ignore) {
      e.stopPropagation();
      return;
    }
    if (r.ended) {
      rec.cancel(); // a palm took over: no glide
      if (r.started) beginPair();
    }
    if (r.inPair) scene.requestRender();
  };
  const onUp = (e) => {
    if (e.pointerType !== 'touch' || !tracker.has(e.pointerId)) return;
    const wasPair = tracker.pair?.some((f) => f.id === e.pointerId);
    if (wasPair) endPair(e.type === 'pointerup' && tracker.size === 2);
    const r = tracker.up(e.pointerId);
    if (r.ignore) {
      e.stopPropagation();
      return;
    }
    if (r.started) beginPair();
    unboost();
  };
  // Any new press anywhere ends a glide (and a wheel turn on the map).
  const onAnyDown = () => stopGlide();
  // The page lost the fingers (another app, a system gesture): start over.
  const onBlur = () => {
    rec.cancel();
    tracker.clear();
    stopGlide();
    unboost();
  };
  const onVisibility = () => document.hidden && onBlur();
  const stopOnMove = camera.beforeMove?.(() => {
    if (!tracker.pair) stopGlide();
  });

  host.addEventListener('pointerdown', onDown, true);
  host.addEventListener('pointermove', onMove, true);
  host.addEventListener('pointerup', onUp, true);
  host.addEventListener('pointercancel', onUp, true);
  window.addEventListener('pointerdown', onAnyDown, true);
  canvas.addEventListener('wheel', onAnyDown, { passive: true });
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);

  return {
    destroy() {
      removePreRender?.();
      stopOnMove?.();
      host.removeEventListener('pointerdown', onDown, true);
      host.removeEventListener('pointermove', onMove, true);
      host.removeEventListener('pointerup', onUp, true);
      host.removeEventListener('pointercancel', onUp, true);
      window.removeEventListener('pointerdown', onAnyDown, true);
      canvas.removeEventListener('wheel', onAnyDown);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const [key, v] of Object.entries(savedTypes)) sscc[key] = v;
      glide = null;
      if (boosted !== null && viewer.targetFrameRate === GESTURE_FPS) {
        viewer.targetFrameRate = boosted;
      }
    },
  };
}
