import * as Cesium from 'cesium';
import { bootGlobe } from '../core/index.js';
import { createCameraControls } from '../core/scene/cameraControls.js';
import { h } from '../core/ui/dom.js';
import {
  DEFAULT_SELF_ICON,
  selfIconPreview,
  turnsWithHeading,
} from '../core/ui/selfIcons.js';
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
  metresPerPixel,
  nearestContacts,
  planLayerClicks,
  speedBetween,
  unitsForLocale,
  wrap360,
} from './model.js';
import {
  bearingAlong,
  createNavGate,
  drivingSideFor,
  indexRoute,
  locateOnRoute,
  navPayload,
  navZoom,
  pointAlong,
  routesPayload,
  searchPayload,
} from './nav.js';
import { createParkedTracker, usesImperialGallon, vehicleView } from './vehicle.js';
import { createRouteView } from './routeView.js';
import { createNavBanner, createVehiclePanel } from './panels.js';
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
// It is also the car's GPS: the Android Auto screens (search, route preview,
// the routing card) ask this page through the same bridge to search, plan and
// follow a route with the navigator (core/nav/navigator.js, handed in by main
// through setNavigator), and the page draws the route, looks ahead along it,
// and reports progress back about once a second. Parked, a VEHICLE panel shows
// the car's own data (setCarInfo); it hides as soon as the car moves.
//
// Also runs in any browser at ?shell=car (navigator.geolocation then drives
// it, and a drag on the globe leaves follow mode), which is how to try it
// without a car; there the page shows its own maneuver banner.

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
  // A search or a plan that arrives first is answered at once with an error
  // (the host retries on the driver's next tap).
  let ctl = null;
  let shellApp = null;
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
    search: (query, reqId) =>
      ctl ? ctl.search(query, reqId) : notReady('searchResults', String(reqId ?? '')),
    preview: (place, opts) => (ctl ? ctl.preview(place, opts) : notReady('routes', opts)),
    selectRoute: (id) => ctl?.selectRoute(id),
    navigate: (routeId) => ctl?.navigate(routeId),
    stopNav: () => ctl?.stopNav(),
    setCarInfo: (json) => (ctl ? ctl.setCarInfo(json) : (early.carInfo = json)),
    state: () => ctl?.state() ?? null,
  };

  /** Call window.ArgusCarHost[method] (the Android app); false outside it. */
  function toHost(method, ...args) {
    const host = window.ArgusCarHost;
    if (typeof host?.[method] !== 'function') return false;
    try {
      host[method](...args);
      return true;
    } catch (err) {
      console.warn(`[car] host ${method} failed`, err);
      return false;
    }
  }

  function notReady(method, arg) {
    const error = 'STARTING';
    if (method === 'searchResults')
      toHost(method, arg, JSON.stringify({ results: [], error }));
    else {
      let reqId = null;
      try {
        reqId = JSON.parse(String(arg)).reqId ?? null;
      } catch {
        reqId = null;
      }
      toHost(method, JSON.stringify({ reqId, routes: [], error }));
    }
  }

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
  // The own-position marker: the icon chosen in SETTINGS (core/ui/selfIcons.js),
  // the same one the phone's globe draws; main hands it over (setSelfIcon).
  const marker = h('div.car-self', { hidden: true, 'aria-hidden': 'true' });
  let selfIcon = DEFAULT_SELF_ICON;
  const drawSelfIcon = (id) => {
    selfIcon = id;
    const art = selfIconPreview(id, 34);
    art.style.display = 'block';
    marker.replaceChildren(art);
  };
  drawSelfIcon(DEFAULT_SELF_ICON);
  // Inside the app Android Auto draws the routing card; the page's own
  // maneuver banner (with its ETA line) is for the browser only. VEHICLE sits
  // on the right while parked.
  const inApp = Boolean(window.ArgusCarHost);
  const banner = createNavBanner({ units });
  const vehiclePanel = createVehiclePanel();
  const topLeft = h('div.car-topleft', {}, inApp ? null : banner.el, status);
  hud.append(topLeft, readout, vehiclePanel.el, notify, marker);

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
  let nav = null; // the navigator (setNavigator)
  let navState = null; // its latest NavState
  let preview = null; // { routes, selectedId, dest } while the host previews routes
  let drive = null; // { route, ix, dest, at, atT } while following a route
  let carInfo = null; // the car's own data (setCarInfo)
  let carInfoAt = 0;

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

  // Navigating: where the vehicle is along the route, carried forward since
  // the last nav update at its speed, for the look-ahead and the zoom.
  function routeAlong(now) {
    if (!drive?.at) return null;
    const moved = clamp((now - drive.atT) / 1000, 0, DEAD_RECKON_S) * (fix.speed || 0);
    return drive.at.along + moved;
  }

  function tick(t) {
    raf = 0;
    if (!following || !fix) return;
    const now = performance.now();
    const pos = predicted(now);
    const along = routeAlong(now);
    let heading = fix.heading;
    let scale = rangeScale;
    let ahead = null;
    if (along !== null) {
      // GPS course is noise at a crawl: steer by the road instead.
      if (!((fix.speed || 0) > 3)) heading = bearingAlong(drive.ix, along) ?? heading;
      scale *= navZoom(navState?.progress?.distanceToStepM, fix.speed);
      ahead = (m) => pointAlong(drive.ix, along + m);
    }
    const target = followPose(
      { lat: pos.lat, lon: pos.lon, heading, speed: fix.speed },
      { scale, mode: viewMode, ahead },
    );
    // Centre the vehicle in what the host leaves free (its routing card and
    // controls cover the sides): slide the view sideways by half the
    // difference between the left and right insets.
    const dx = (insets.left - insets.right) / 2;
    if (Math.abs(dx) >= 1) {
      const mpp = metresPerPixel(
        target.range,
        cam.frustum?.fov,
        scene.canvas.clientWidth,
        scene.canvas.clientHeight,
      );
      const moved = destination(target.lat, target.lon, target.heading - 90, dx * mpp);
      target.lat = moved.lat;
      target.lon = moved.lon;
    }
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
    const fixOut = {
      lat: fix.lat,
      lon: fix.lon,
      heading: fix.heading,
      speed: fix.speed,
      accuracy: fix.accuracy,
      t: Date.now(),
    };
    // The route follows the vehicle (progress, off route, arrival), and the
    // rest of the app sees the phone's fix (core/geo/selfPosition.js; the
    // browser fallback's own fixes reach it without this).
    if (nav && drive) {
      try {
        nav.update(fixOut);
      } catch (err) {
        console.warn('[car] nav update failed', err);
      }
    }
    if (pushed) {
      try {
        shellApp?.selfPosition?.push?.({ ...fixOut, source: 'car' });
      } catch {
        // a main without a self position
      }
    }
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
    const turn = turnsWithHeading(selfIcon)
      ? (fix.heading ?? 0) - Cesium.Math.toDegrees(cam.heading)
      : 0;
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
    // The free part of the screen moved: the follow view re-centres on it.
    startFollow();
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
    put(cells.mode, !fix ? 'NO FIX' : drive ? 'ROUTE' : following ? 'FOLLOW' : 'FREE');
    status.classList.toggle('is-stale', !fresh);
    refreshVehicle();
  }

  // ------------------------------------------------------------- vehicle
  // The VEHICLE panel: shown once the car has stood still for three seconds
  // (its own speedometer when the app reads it, else the GPS), hidden the
  // moment it moves, and never over an active route.
  const parked = createParkedTracker();
  const imperialGallon = usesImperialGallon(navigator.language);
  function speedNow(now) {
    if (carInfo && Number.isFinite(carInfo.speedMps) && now - carInfoAt < 3000)
      return carInfo.speedMps;
    return fix && now - fix.t < FIX_STALE_MS ? fix.speed : null;
  }
  function refreshVehicle() {
    const now = performance.now();
    const still = parked.update(speedNow(now), now);
    const routing = preview || (drive && navState?.status !== 'arrived');
    const view = carInfo ? vehicleView(carInfo, { units, imperialGallon }) : null;
    if (still && !routing && view?.known) vehiclePanel.show(view);
    else vehiclePanel.hide();
  }

  function setCarInfo(json) {
    let info = json;
    if (typeof json === 'string') {
      try {
        info = JSON.parse(json);
      } catch {
        return;
      }
    }
    if (!info || typeof info !== 'object') return;
    carInfo = info;
    carInfoAt = performance.now();
    refreshVehicle();
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
  // While previewing routes the readout steps aside for them; on a route it
  // keeps to two rows, and only where the routing card leaves room for it
  // beside the vehicle.
  const READOUT_ROUTE_MIN_PX = 900;
  function renderReadout() {
    const now = performance.now();
    if (now - lastReadout < 500) return; // calm: twice a second at most
    lastReadout = now;
    const free = (scene.canvas.clientWidth || 0) - insets.left - insets.right;
    if (preview || (drive && free < READOUT_ROUTE_MIN_PX)) {
      readout.hidden = true;
      return;
    }
    const max = drive ? 2 : 3;
    readout.classList.toggle('is-route', Boolean(drive));
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
    for (const c of nearestContacts(contacts, here, hub?.target ? max - 1 : max, {
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

  // ----------------------------------------------------------- navigation
  // The Android Auto screens drive this through the bridge: search(query,
  // reqId) -> ArgusCarHost.searchResults(reqId, json); preview(place, opts)
  // -> ArgusCarHost.routes(json); navigate(routeId); stopNav(). Progress goes
  // back as ArgusCarHost.nav(json), at most once a second plus at once on a
  // new step or status (nav.js createNavGate).
  const side = drivingSideFor(navigator.language);
  const routeView = createRouteView(viewer);
  const navGate = createNavGate();
  let navUnsub = null;
  let navTimer = 0;
  let previewSeq = 0;

  function log(level, title, err) {
    if (level === 'warn') console.warn(`[car] ${title}`, err);
    try {
      shellApp?.logs?.add?.({
        level,
        source: 'car',
        title,
        body: String(err?.message ?? err ?? ''),
      });
    } catch {
      // no log store in this build
    }
  }

  function parseJson(v) {
    if (v && typeof v === 'object') return v;
    try {
      return JSON.parse(String(v));
    } catch {
      return null;
    }
  }

  // Where to plan from and search near: the car's fix, else the app's.
  function currentPosition() {
    if (fix) return { lat: fix.lat, lon: fix.lon };
    try {
      const p = shellApp?.selfPosition?.get?.();
      if (Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
        return { lat: p.lat, lon: p.lon };
    } catch {
      // no self position
    }
    return null;
  }

  function setNavigator(next) {
    if (next === nav) return;
    navUnsub?.();
    navUnsub = null;
    nav = next && typeof next.plan === 'function' ? next : null;
    if (typeof nav?.subscribe === 'function') navUnsub = nav.subscribe(onNavState);
  }

  async function search(query, reqId) {
    const id = String(reqId ?? '');
    const q = String(query ?? '')
      .trim()
      .slice(0, 200);
    const reply = (body) => toHost('searchResults', id, JSON.stringify(body));
    if (!q) return reply({ results: [] });
    if (!nav) return reply({ results: [], error: 'NAVIGATION OFFLINE' });
    const here = currentPosition();
    try {
      const places = await nav.search(q, { near: here ?? undefined, limit: 8 });
      reply(searchPayload(places, here, units));
    } catch (err) {
      log('warn', 'SEARCH FAILED', err);
      reply({ results: [], error: 'SEARCH FAILED' });
    }
  }

  async function previewRoutes(placeJson, optsJson) {
    const place = parseJson(placeJson);
    const opts = parseJson(optsJson) ?? {};
    const reqId = opts.reqId ?? null;
    const reply = (body) => toHost('routes', JSON.stringify(body));
    const lat = Number(place?.lat);
    const lon = Number(place?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon))
      return reply({ reqId, routes: [], error: 'NO DESTINATION' });
    const dest = { ...place, lat, lon, name: String(place.name ?? '') };
    if (!nav) return reply({ reqId, routes: [], error: 'NAVIGATION OFFLINE' });
    const from = currentPosition();
    if (!from) return reply({ reqId, routes: [], error: 'NO POSITION' });
    const seq = (previewSeq += 1);
    try {
      const routes = await nav.plan(from, dest, {
        mode: 'drive',
        avoidHighways: Boolean(opts.avoidHighways),
        traffic: true,
      });
      if (seq !== previewSeq) return; // a newer request (or a stop) came first
      const list = (routes || []).filter((r) => r?.geometry?.length >= 2).slice(0, 3);
      if (!list.length) return reply({ reqId, routes: [], error: 'NO ROUTE' });
      showPreview(list, dest);
      reply(routesPayload(list, units, reqId));
    } catch (err) {
      if (seq !== previewSeq) return;
      log('warn', 'ROUTE FAILED', err);
      reply({ reqId, routes: [], error: 'NO ROUTE' });
    }
  }

  function showPreview(routes, dest) {
    preview = { routes, selectedId: routes[0].id, dest };
    if (drive) endDrive();
    routeView.showPreview(routes, preview.selectedId, dest);
    fitPreview();
  }

  // Frame the routes in the part of the screen the host's cards leave free:
  // the box is widened by the share of the screen each inset covers.
  function fitPreview() {
    const b = preview && routeView.bounds(preview.routes, preview.dest);
    if (!b) return;
    let [w, s, e, n] = b;
    const padX = (e - w) * 0.1 + 0.002;
    const padY = (n - s) * 0.1 + 0.002;
    w -= padX;
    e += padX;
    s -= padY;
    n += padY;
    const W = scene.canvas.clientWidth || 1;
    const H = scene.canvas.clientHeight || 1;
    const top = Math.max(insets.top, topLeft.getBoundingClientRect().bottom);
    const fullX = (e - w) / Math.max(0.25, 1 - (insets.left + insets.right) / W);
    const fullY = (n - s) / Math.max(0.25, 1 - (top + insets.bottom) / H);
    w -= (fullX * insets.left) / W;
    e += (fullX * insets.right) / W;
    n += (fullY * top) / H;
    s -= (fullY * insets.bottom) / H;
    setFollowing(false);
    cam.flyTo({
      destination: Cesium.Rectangle.fromDegrees(w, Math.max(-89, s), e, Math.min(89, n)),
      duration: 1.2,
    });
  }

  function selectRoute(id) {
    if (!preview) return;
    const key = String(id);
    if (!preview.routes.some((r) => r.id === key) || preview.selectedId === key) return;
    preview.selectedId = key;
    routeView.showPreview(preview.routes, key, preview.dest);
  }

  function navigateTo(routeId) {
    const routes = preview?.routes ?? navState?.routes ?? [];
    const route = routes.find((r) => r.id === String(routeId)) ?? routes[0];
    if (!nav || !route) {
      log('warn', 'NAVIGATE: NO ROUTE', routeId);
      navState = { status: 'idle' };
      pushNav(true);
      return;
    }
    const dest = preview?.dest ?? navState?.destination ?? null;
    preview = null;
    startDrive(route, dest);
    try {
      nav.start(route);
    } catch (err) {
      log('warn', 'NAVIGATE FAILED', err);
    }
    // Back to the vehicle, closer in, heading up.
    rangeScale = 1;
    viewSet = false;
    setFollowing(true);
  }

  function startDrive(route, dest) {
    drive = { route, ix: indexRoute(route.geometry), dest, at: null, atT: 0 };
    routeView.showActive(route, dest);
    navGate.reset();
    refreshStatus();
  }

  function endDrive() {
    if (!drive && !preview) return;
    drive = null;
    routeView.clear();
    banner.hide();
    refreshStatus();
  }

  function onNavState(state) {
    navState = state;
    const status = state?.status ?? 'idle';
    if (['navigating', 'rerouting', 'arrived'].includes(status) && state.route) {
      // A reroute brings a new route: draw it in place of the old one.
      if (!drive || drive.route.id !== state.route.id)
        startDrive(state.route, state.destination ?? drive?.dest ?? null);
      const s = state.progress?.snapped;
      if (s && drive.ix.n >= 2) {
        drive.at = locateOnRoute(drive.ix, s.lat, s.lon, drive.at?.index ?? 0);
        drive.atT = performance.now();
        routeView.setProgress(drive.at);
      }
    } else if (status === 'idle' && drive) {
      endDrive();
    }
    pushNav();
  }

  function stopNav() {
    previewSeq += 1; // a plan still on its way is dropped
    const had = Boolean(drive || preview);
    navState = { status: 'idle' };
    try {
      nav?.stop?.();
    } catch (err) {
      log('warn', 'STOP FAILED', err);
    }
    preview = null;
    endDrive();
    routeView.clear();
    navGate.reset();
    pushNav(true);
    if (had) ctl.recenter();
  }

  function pushNav(force = false) {
    clearTimeout(navTimer);
    navTimer = 0;
    const payload = navPayload(navState ?? { status: 'idle' }, { units, side });
    if (!inApp) {
      const was = banner.el.hidden;
      banner.update(payload);
      // The banner pushes the strip down: the overlay's frame follows.
      if (was !== banner.el.hidden) layoutOverlay();
      return;
    }
    const now = performance.now();
    const verdict = force ? 'send' : navGate.decide(payload, now);
    if (verdict === 'skip') return;
    if (verdict === 'later') {
      navTimer = setTimeout(() => pushNav(), navGate.wait(now));
      return;
    }
    if (toHost('nav', JSON.stringify(payload))) navGate.sent(payload, now);
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
    search,
    preview: previewRoutes,
    selectRoute,
    navigate: navigateTo,
    stopNav,
    setCarInfo,
    state: () => ({
      following,
      rangeScale,
      view: viewMode,
      fix: fix && { ...fix },
      layers: wantLayers ? [...wantLayers] : null,
      insets: { ...insets },
      nav: navState?.status ?? (nav ? 'idle' : 'offline'),
      route: drive ? drive.route.id : null,
      preview: preview ? preview.routes.map((r) => r.id) : null,
      vehicle: vehiclePanel.shown,
    }),
  };

  shellApp = {
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
    /** The own-position icon chosen in SETTINGS (main passes it on change). */
    setSelfIcon: (id) => drawSelfIcon(id),
    /**
     * Hand the car its navigator (core/nav/navigator.js createNavigator), once
     * main has a proxy client; until then searches and plans answer
     * NAVIGATION OFFLINE. Anything with search/plan/start/stop/update/
     * subscribe will do (the harness passes a fake with canned routes).
     */
    setNavigator,
  };
  if (early.insets) setInsets(...early.insets);
  if (early.view) setView(early.view);
  if (early.location) setLocation(...early.location);
  if (early.layers) setLayers(early.layers);
  if (early.carInfo) setCarInfo(early.carInfo);
  if (bootOpts.navigator) setNavigator(bootOpts.navigator);
  // Tell the app the page is listening, so it sends the current state.
  try {
    window.ArgusCarHost?.ready?.();
  } catch {
    // not inside the app
  }
  return shellApp;
}

export const shellName = 'car';
