import * as Cesium from 'cesium';
import { bootGlobe } from '../core/index.js';
import { createCameraControls } from '../core/scene/cameraControls.js';
import { h } from '../core/ui/dom.js';
import {
  VIEW_MODES,
  angleDelta,
  carResolutionScale,
  clamp,
  courseFor,
  destination,
  followFrameMs,
  followPose,
  formatDistance,
  formatHeading,
  formatSpeed,
  isParkedJitter,
  layerCode,
  lerp,
  nearestContacts,
  planLayerClicks,
  speedBetween,
  unitsForLocale,
  wrap360,
} from './model.js';
import '../core/ui/theme.css';
import './shell.css';

// Car shell (Android Auto). The Android app draws this page on the car display
// (android/.../car/CarMapRenderer.kt) and drives it through window.argusCar:
// gestures from the car's screen, the phone's location, and the car's LAYERS
// and VIEW buttons. The view follows the vehicle: tilted 3D heading up, flat
// 2D heading up, or 2D north up, 1.8 to 6.5 km up depending on speed.
// Driver-distraction rules shape the UI: the map, a status strip (speed,
// heading, view, mode), the nearest contacts ahead in large type and the
// tracking boxes; no menus, no text entry, no video. Main still mounts its
// components; the slots this shell has no place for are ignored.
//
// It draws on the phone's GPU beside whatever the phone draws, so it renders
// only what changed: the follow view updates 12 to 20 times a second while
// the vehicle moves and stops when it stands (GPS wander is held still), the
// render target is held to a pixel budget, and moving layers tick slowly.
//
// Also runs in any browser at ?shell=car (navigator.geolocation then drives
// it, and a drag on the globe leaves follow mode), which is how to try it
// without a car.

const EASE_S = 0.35; // how quickly the follow view settles on a new fix
const DEAD_RECKON_S = 2; // carry a fix forward along its course this long
// Moving layers (aircraft) tick this often in the car: enough to see them
// move, a third of the frames a phone spends on them.
const CAR_ANIMATION_FPS = 8;
const FIX_STALE_MS = 5000;
const GEO_FALLBACK_MS = 6000; // no fix pushed by the app: use the WebView's own
const SYNTHETIC_POINTER = 4242;

/**
 * @param {HTMLElement} root
 * @param {object} [bootOpts]  main's settings; the car keeps its own light profile
 */
export async function mountShell(root, bootOpts = {}) {
  root.classList.add('argus-shell-car');
  const globeEl = h('div.argus-globe');
  const hud = h('div.argus-hud');
  root.append(globeEl, hud);

  // The API exists before the globe does: early calls are kept, latest wins.
  let ctl = null;
  const early = {};
  window.argusCar = {
    pan: (...a) => ctl?.pan(...a),
    zoom: (...a) => ctl?.zoom(...a),
    tap: (...a) => ctl?.tap(...a),
    recenter: () => ctl?.recenter(),
    setLocation: (...a) => (ctl ? ctl.setLocation(...a) : (early.location = a)),
    setLayers: (keys) => (ctl ? ctl.setLayers(keys) : (early.layers = keys)),
    setInsets: (...a) => (ctl ? ctl.setInsets(...a) : (early.insets = a)),
    setView: (mode) => (ctl ? ctl.setView(mode) : (early.view = mode)),
    state: () => ctl?.state() ?? null,
  };

  // The car display is a second screen on the phone's GPU, rendering while the
  // phone may render too: the lightest tier, a fixed budget of rendered pixels
  // whatever the car's screen (model.js carResolutionScale), and slow ticks
  // for moving layers.
  const dpr = window.devicePixelRatio || 1;
  const app = await bootGlobe(globeEl, {
    onContextChange: bootOpts.onContextChange,
    tier: 'minimal',
    profile: {
      resolutionScale: carResolutionScale(
        window.innerWidth || 1280,
        window.innerHeight || 720,
        dpr,
      ),
      targetFrameRate: 30,
      animationFps: CAR_ANIMATION_FPS,
    },
  });
  const { viewer } = app;
  const { scene } = viewer;
  const cam = viewer.camera;
  const controls = createCameraControls(viewer);
  const units = unitsForLocale(navigator.language);

  // ------------------------------------------------------------------ HUD
  const cell = (label) => {
    const value = h('span.car-cell__value', {}, '--');
    return {
      el: h('div.car-cell', {}, h('span.car-cell__label', {}, label), value),
      value,
    };
  };
  // Speed and heading first and largest; the car's own bar already shows the
  // time. VIEW echoes the VIEW button, MODE says whether the map follows.
  const cells = {
    speed: cell('SPD'),
    heading: cell('HDG'),
    view: cell('VIEW'),
    mode: cell('MODE'),
  };
  cells.speed.el.classList.add('car-cell--lead');
  const status = h(
    'div.car-status',
    { role: 'status' },
    ...Object.values(cells).map((c) => c.el),
  );
  const readout = h('div.car-readout', { hidden: true });
  const notify = h('div.car-notify');
  const marker = h('div.car-self', { hidden: true, 'aria-hidden': 'true' });
  marker.innerHTML =
    '<svg viewBox="0 0 32 32" width="34" height="34"><path d="M16 2 27 29 16 22 5 29Z" fill="#fff" stroke="#0e0e0e" stroke-width="2" stroke-linejoin="round"/></svg>';
  hud.append(status, readout, notify, marker);

  // ---------------------------------------------------------------- state
  let fix = null; // { lat, lon, heading, speed, accuracy, t }
  let fromApp = false;
  let following = true;
  let rangeScale = 1;
  let viewMode = '3d';
  let overlay = null;
  let summary = null;
  let wantLayers = null;
  let layerTimer = null;
  const menus = []; // main's layer menu: kept off screen, driven by setLayers
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };

  // ------------------------------------------------------------ following
  const view = { lat: 0, lon: 0, heading: 0, pitch: VIEW_MODES['3d'].pitch, range: 0 };
  let viewSet = false;
  let acquiringUntil = 0;
  let raf = 0;
  let lastTick = 0;
  const hpr = new Cesium.HeadingPitchRange();
  const carto = new Cesium.Cartographic();
  const centre = new Cesium.Cartesian3();

  function predicted(now) {
    const dt = clamp((now - fix.t) / 1000, 0, DEAD_RECKON_S);
    const ahead = dt * (fix.speed || 0);
    return ahead > 0.5 ? destination(fix.lat, fix.lon, fix.heading, ahead) : fix;
  }

  function applyView() {
    Cesium.Cartographic.fromDegrees(view.lon, view.lat, 0, carto);
    const ground = scene.globe.getHeight(carto) ?? 0;
    Cesium.Cartesian3.fromDegrees(
      view.lon,
      view.lat,
      ground,
      Cesium.Ellipsoid.WGS84,
      centre,
    );
    hpr.heading = Cesium.Math.toRadians(view.heading);
    hpr.pitch = Cesium.Math.toRadians(view.pitch);
    hpr.range = view.range;
    cam.lookAt(centre, hpr);
    cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
    scene.requestRender();
  }

  function startFollow() {
    if (!raf && following && fix) raf = requestAnimationFrame(tick);
  }

  const settledOn = (target) =>
    Math.abs(view.lat - target.lat) < 1e-6 &&
    Math.abs(angleDelta(view.lon, target.lon)) < 1e-6 &&
    Math.abs(angleDelta(view.heading, target.heading)) < 0.05 &&
    Math.abs(view.pitch - target.pitch) < 0.05 &&
    Math.abs(view.range - target.range) < 1;

  function tick(t) {
    raf = 0;
    if (!following || !fix) return;
    const now = performance.now();
    const pos = predicted(now);
    const target = followPose(
      { lat: pos.lat, lon: pos.lon, heading: fix.heading, speed: fix.speed },
      { scale: rangeScale, mode: viewMode },
    );
    // 20 updates a second on the move or in a turn, 12 when creeping.
    const frameMs = followFrameMs(
      fix.speed,
      viewSet ? angleDelta(view.heading, target.heading) : 0,
    );
    if (t - lastTick < frameMs) {
      raf = requestAnimationFrame(tick);
      return;
    }
    const dt = lastTick ? Math.min(0.5, (t - lastTick) / 1000) : frameMs / 1000;
    lastTick = t;
    if (!viewSet) {
      // First fix: fly in from wherever the globe is, then follow.
      Object.assign(view, target);
      viewSet = true;
      acquiringUntil = now + 2100;
      controls.flyAround({
        longitude: target.lon,
        latitude: target.lat,
        range: target.range,
        heading: target.heading,
        pitch: target.pitch,
        duration: 2,
      });
    } else if (now >= acquiringUntil && !settledOn(target)) {
      // Only a view that is still on its way moves the camera: once it rests
      // on the target, nothing renders and nothing refetches until the next
      // real change.
      const k = 1 - Math.exp(-dt / EASE_S);
      view.lat = lerp(view.lat, target.lat, k);
      view.lon = wrap360(view.lon + angleDelta(view.lon, target.lon) * k + 180) - 180;
      view.heading = wrap360(view.heading + angleDelta(view.heading, target.heading) * k);
      view.pitch = lerp(view.pitch, target.pitch, k);
      view.range = lerp(view.range, target.range, k);
      applyView();
    }
    if (!settledOn(target) || (fix.speed || 0) > 0.3 || now < acquiringUntil) {
      raf = requestAnimationFrame(tick);
    } else {
      lastTick = 0;
    }
  }

  function setFollowing(on) {
    following = Boolean(on);
    if (!following) {
      cancelAnimationFrame(raf);
      raf = 0;
      lastTick = 0;
      acquiringUntil = 0;
    }
    refreshStatus();
    startFollow();
  }

  // ------------------------------------------------------- free-look input
  const win = new Cesium.Cartesian2();
  const pickGround = (x, y, result) => {
    win.x = x;
    win.y = y;
    return cam.pickEllipsoid(win, scene.globe.ellipsoid, result);
  };
  const middle = () => ({
    x: insets.left + (scene.canvas.clientWidth - insets.left - insets.right) / 2,
    y: insets.top + (scene.canvas.clientHeight - insets.top - insets.bottom) / 2,
  });
  const a = new Cesium.Cartesian3();
  const b = new Cesium.Cartesian3();
  const moved = new Cesium.Cartesian3();

  // Drag the map by dx, dy CSS pixels: the ground follows the finger.
  function panBy(dx, dy) {
    const c = middle();
    if (!pickGround(c.x, c.y, a) || !pickGround(c.x - dx, c.y - dy, b)) return;
    Cesium.Cartesian3.subtract(b, a, moved);
    Cesium.Cartesian3.add(cam.positionWC, moved, moved);
    cam.setView({
      destination: moved,
      orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
    });
    scene.requestRender();
  }

  let panRaf = 0;
  function pan(dx, dy, ms = 0) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    setFollowing(false);
    cancelAnimationFrame(panRaf);
    if (!(ms > 0)) return panBy(dx, dy);
    // A fling: glide the distance out with an ease-out.
    const start = performance.now();
    let done = 0;
    const step = (t) => {
      const p = clamp((t - start) / ms, 0, 1);
      const eased = 1 - (1 - p) ** 3;
      panBy(dx * (eased - done), dy * (eased - done));
      done = eased;
      if (p < 1) panRaf = requestAnimationFrame(step);
    };
    panRaf = requestAnimationFrame(step);
  }

  const toward = new Cesium.Cartesian3();
  function zoom(factor, x, y) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    if (following) {
      // Zooming while following changes the follow range, not the camera.
      rangeScale = clamp(rangeScale / factor, 0.15, 6);
      startFollow();
      return;
    }
    const c = middle();
    const target =
      pickGround(Number.isFinite(x) ? x : c.x, Number.isFinite(y) ? y : c.y, a) ??
      pickGround(c.x, c.y, a);
    if (!target) {
      controls.zoomStep(factor > 1 ? 1 : -1);
      return;
    }
    Cesium.Cartesian3.subtract(target, cam.positionWC, toward);
    const dist = Cesium.Cartesian3.magnitude(toward);
    // Not closer than 150 m to the ground point, not past 20,000 km out.
    const step = clamp(dist * (1 - 1 / factor), dist - 20_000_000, dist - 150);
    Cesium.Cartesian3.normalize(toward, toward);
    cam.move(toward, step);
    scene.requestRender();
  }

  // A tap on the car screen selects what is under it, through main's own
  // picker (Pointer Events on the canvas). A synthetic pointer cannot be
  // captured, so capture is skipped for just these two events.
  function tap(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const canvas = scene.canvas;
    const init = {
      clientX: x,
      clientY: y,
      pointerId: SYNTHETIC_POINTER,
      pointerType: 'touch',
      isPrimary: true,
      bubbles: true,
      cancelable: true,
      button: 0,
    };
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    try {
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    } finally {
      delete canvas.setPointerCapture;
      delete canvas.releasePointerCapture;
    }
  }

  // In a browser, a real press on the globe takes over from follow mode.
  scene.canvas.addEventListener('pointerdown', (e) => {
    if (e.isTrusted) setFollowing(false);
  });

  // ------------------------------------------------------------- location
  function setLocation(lat, lon, heading, speed, accuracy, { app: pushed = true } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    if (pushed && !fromApp) {
      fromApp = true;
      stopGeolocation();
    }
    const next = {
      lat,
      lon,
      heading: Number.isFinite(heading) ? heading : null,
      speed: Number.isFinite(speed) && speed >= 0 ? speed : null,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      t: performance.now(),
    };
    // Standing still, the GPS wanders a few metres a second: hold the last
    // position, or the view would creep, re-render and refetch every fix.
    // (Checked before speed is derived from positions, which wander too.)
    if (isParkedJitter(fix, next)) {
      next.lat = fix.lat;
      next.lon = fix.lon;
      next.speed ??= 0;
    }
    if (next.speed === null) next.speed = speedBetween(fix, next);
    next.heading = courseFor(fix, next);
    fix = next;
    refreshStatus();
    startFollow();
  }

  // Fallback when the app pushes nothing (a browser, or an older app build).
  let watchId = null;
  function stopGeolocation() {
    if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
    watchId = null;
  }
  setTimeout(() => {
    if (fromApp || !navigator.geolocation) return;
    watchId = navigator.geolocation.watchPosition(
      (p) =>
        setLocation(
          p.coords.latitude,
          p.coords.longitude,
          p.coords.heading,
          p.coords.speed,
          p.coords.accuracy,
          { app: false },
        ),
      () => {},
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
    );
  }, GEO_FALLBACK_MS);

  // The own-position chevron, kept on the vehicle as the view moves.
  const selfPos = new Cesium.Cartesian3();
  scene.postRender.addEventListener(() => {
    if (!fix) return;
    const p = predicted(performance.now());
    Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 0, Cesium.Ellipsoid.WGS84, selfPos);
    const s = Cesium.SceneTransforms.worldToWindowCoordinates(scene, selfPos, win);
    if (!s) {
      marker.hidden = true;
      return;
    }
    marker.hidden = false;
    const turn = (fix.heading ?? 0) - Cesium.Math.toDegrees(cam.heading);
    marker.style.transform = `translate(${s.x}px, ${s.y}px) rotate(${turn}deg)`;
  });

  // --------------------------------------------------------------- layers
  function reconcileLayers() {
    if (!wantLayers) return;
    const rows = menus.flatMap((m) => [...m.querySelectorAll('[data-layer]')]);
    const states = rows.map((row) => ({
      row,
      key: row.dataset.layer,
      on: row.getAttribute('aria-pressed') === 'true',
      loading: Boolean(row.querySelector('.is-load')),
    }));
    for (const key of planLayerClicks(states, wantLayers)) {
      states.find((s) => s.key === key)?.row.click();
    }
  }

  // The car's LAYERS list offers only the layers this build can actually show
  // (a keyed layer appears once the phone's proxy has its key): tell the app
  // which, whenever that set changes.
  let reportedLayers = '';
  function reportLayers() {
    const keys = menus.flatMap((m) =>
      [...m.querySelectorAll('[data-layer]')].map((r) => r.dataset.layer),
    );
    const json = JSON.stringify([...new Set(keys)].sort());
    if (!keys.length || json === reportedLayers) return;
    reportedLayers = json;
    try {
      window.ArgusCarHost?.layers?.(json);
    } catch {
      // not inside the app (a browser at ?shell=car)
    }
  }

  function setLayers(keys) {
    if (!Array.isArray(keys)) return;
    wantLayers = new Set(keys.map(String));
    reconcileLayers();
    // Main switches the link's layers on one by one as the scene starts:
    // settle once more after that.
    clearTimeout(layerTimer);
    layerTimer = setTimeout(() => {
      reconcileLayers();
      reportLayers();
    }, 3000);
  }

  // ----------------------------------------------------------------- view
  function setView(mode) {
    if (!VIEW_MODES[mode] || mode === viewMode) return;
    viewMode = mode;
    // Following, the view eases into the new pitch and heading; in free look,
    // the new view takes the map back to the vehicle.
    if (following) startFollow();
    else ctl.recenter();
    refreshStatus();
  }

  // --------------------------------------------------------------- insets
  function setInsets(top, right, bottom, left) {
    const v = [top, right, bottom, left].map((n) =>
      Number.isFinite(n) ? Math.max(0, n) : 0,
    );
    [insets.top, insets.right, insets.bottom, insets.left] = v;
    root.style.setProperty('--car-top', `${insets.top}px`);
    root.style.setProperty('--car-right', `${insets.right}px`);
    root.style.setProperty('--car-bottom', `${insets.bottom}px`);
    root.style.setProperty('--car-left', `${insets.left}px`);
    layoutOverlay();
  }

  function layoutOverlay() {
    if (!overlay) return;
    const top = status.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
    overlay.setInsets({
      top: Math.max(insets.top, top),
      right: insets.right,
      bottom: insets.bottom,
      left: insets.left,
    });
  }

  // ----------------------------------------------------------- readouts
  const pad2 = (n) => String(n).padStart(2, '0');
  // Each cell is written only when its text changes: no style or layout work
  // for an unchanged strip, once a second.
  const put = (c, text) => {
    if (c.value.textContent !== text) c.value.textContent = text;
  };
  function refreshStatus() {
    // Backgrounded (the browser ?shell=car fallback): skip the repaint. The
    // next visible tick catches the fix up, so nothing is lost.
    if (typeof document !== 'undefined' && document.hidden) return;
    const fresh = fix && performance.now() - fix.t < FIX_STALE_MS;
    put(cells.speed, formatSpeed(fresh ? fix.speed : NaN, units));
    put(cells.heading, formatHeading(fresh ? fix.heading : NaN));
    put(cells.view, VIEW_MODES[viewMode].label);
    put(cells.mode, !fix ? 'NO FIX' : following ? 'FOLLOW' : 'FREE');
    status.classList.toggle('is-stale', !fresh);
  }
  setInterval(refreshStatus, 1000);
  refreshStatus();

  const pos = new Cesium.Cartesian3();
  const pc = new Cesium.Cartographic();
  const latLonOf = (target) => {
    const p = target?.position?.getValue?.(viewer.clock.currentTime, pos);
    if (!p) return null;
    const c = Cesium.Cartographic.fromCartesian(p, Cesium.Ellipsoid.WGS84, pc);
    return c
      ? {
          lat: Cesium.Math.toDegrees(c.latitude),
          lon: Cesium.Math.toDegrees(c.longitude),
        }
      : null;
  };

  let lastReadout = 0;
  function renderReadout() {
    const now = performance.now();
    if (now - lastReadout < 500) return; // calm: twice a second at most
    lastReadout = now;
    const here = fix ? predicted(now) : null;
    const rows = [];
    const hub = summary?.hub;
    if (hub?.target) {
      const at = latLonOf(hub.target);
      const near = at && here ? nearestContacts([at], here, 1)[0] : null;
      rows.push(
        row(
          '00',
          hub.label || 'TARGET',
          hub.sub || 'TRACK',
          near?.distanceM,
          near?.bearingDeg,
          true,
        ),
      );
    }
    const contacts = (summary?.contacts ?? [])
      .filter((c) => c.target !== hub?.target)
      .map((c) => ({ ...c, ...latLonOf(c.target) }));
    // What lies ahead first: a driver acts on what is coming (model.js).
    const course = fix && fix.speed > 1 ? fix.heading : null;
    for (const c of nearestContacts(contacts, here, hub?.target ? 2 : 3, {
      heading: course,
    })) {
      rows.push(
        row(
          pad2(c.id ?? 0),
          c.label || layerCode(c.key),
          layerCode(c.key),
          c.distanceM,
          c.bearingDeg,
          false,
          c.ahead === true,
        ),
      );
    }
    readout.replaceChildren(...rows);
    readout.hidden = rows.length === 0;
  }

  function row(id, name, kind, distance, bearing, isHub = false, isAhead = false) {
    // The arrow points the way the contact lies on the map: relative to the
    // course in the heading-up views, to north in the north-up one.
    const up = VIEW_MODES[viewMode].headingUp ? (fix?.heading ?? 0) : 0;
    const rel = Number.isFinite(bearing) && fix ? wrap360(bearing - up) : null;
    return h(
      `div.car-row${isHub ? '.is-hub' : ''}${isAhead ? '.is-ahead' : ''}`,
      {},
      h('span.car-row__id', {}, id),
      h('span.car-row__name', {}, String(name).slice(0, 16)),
      h('span.car-row__kind', {}, String(kind).slice(0, 18)),
      h(
        'span.car-row__range',
        {},
        Number.isFinite(distance) ? formatDistance(distance, units) : '',
      ),
      h(
        'span.car-row__dir',
        { style: rel === null ? { visibility: 'hidden' } : {} },
        h('span.car-row__arrow', { style: { transform: `rotate(${rel ?? 0}deg)` } }, '▲'),
      ),
    );
  }

  // ------------------------------------------------------------- control
  ctl = {
    pan,
    zoom,
    tap,
    recenter() {
      rangeScale = 1;
      // Fly back from wherever free look left the camera, then follow.
      viewSet = false;
      setFollowing(true);
    },
    setLocation,
    setLayers,
    setInsets,
    setView,
    state: () => ({
      following,
      rangeScale,
      view: viewMode,
      fix: fix && { ...fix },
      layers: wantLayers ? [...wantLayers] : null,
      insets: { ...insets },
    }),
  };
  if (early.insets) setInsets(...early.insets);
  if (early.view) setView(early.view);
  if (early.location) setLocation(...early.location);
  if (early.layers) setLayers(early.layers);
  // Tell the app the page is listening, so it sends the current state.
  try {
    window.ArgusCarHost?.ready?.();
  } catch {
    // not inside the app
  }

  return {
    ...app,
    shell: 'car',
    /**
     * Place a component. The car shows only notifications (critical ones, by
     * CSS) and keeps the layer menu off screen for setLayers; everything else
     * (menus, search, panels, terminal) has no place on a car display.
     */
    mount(slot, el) {
      if (!el) return;
      if (slot === 'notify') notify.appendChild(el);
      else if (slot === 'layers') {
        menus.push(el);
        reconcileLayers();
        reportLayers();
      }
    },
    attachOverlay(o) {
      overlay = o;
      o.setOptions({ density: 'low' });
      o.subscribe((s) => {
        summary = s;
        renderReadout();
      });
      layoutOverlay();
    },
    focusTarget() {},
    showTab() {},
    setClean() {},
    // Satellite pass predictions: the vehicle's own position.
    observer: async () => (fix ? { latitude: fix.lat, longitude: fix.lon } : null),
  };
}

export const shellName = 'car';
