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
  CAR_LAYER_KEYS,
  VIEW_MODES,
  aimFor,
  angleDelta,
  carResolutionScale,
  clamp,
  courseFor,
  destination,
  followFrameMs,
  followPose,
  formatDistance,
  isParkedJitter,
  layerCode,
  lerp,
  nearestContacts,
  planLayerClicks,
  shouldResumeFollow,
  speedBetween,
  unitsForLocale,
  viewModeOf,
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
  routesPayload,
  searchPayload,
} from './nav.js';
import {
  createParkedTracker,
  usesImperialGallon,
  vehicleChip,
  vehicleView,
} from './vehicle.js';
import { createRouteView } from './routeView.js';
import { createNavBanner, createVehicleWidget } from './panels.js';
import { createSharedLayers } from '../core/share/session.js';
import { decodeShareHash } from '../core/share/state.js';

/** The layer keys in a share hash ('#v=1&layers=...'), [] without any. */
const hashLayers = (hash) => decodeShareHash(hash)?.layers ?? [];
import '../core/ui/theme.css';
import './shell.css';

// Car shell (Android Auto). The Android app draws this page on the car display
// (android/.../car/CarMapRenderer.kt) and drives it through window.argusCar:
// gestures from the car's screen, the phone's location, and the car's LAYERS
// and AUTO / NORTH buttons. The view follows the vehicle as a GPS app does,
// the vehicle in the middle of the part of the screen Android Auto leaves
// free: AUTO (tilted, heading up) or NORTH (flat, north up), 1.8 to 6.5 km up
// by speed and closer before a turn; a drag looks round the map and, once the
// driver lets it be for ten seconds on the move, it follows again (RECENTER
// at once).
// Driver-distraction rules shape the UI: the map, a small speed readout
// (SPEED in the car's LAYERS list hides it), the nearest contacts ahead and
// the tracking boxes; no menus, no text entry, no video. Main still mounts its components;
// the slots this shell has no place for are ignored.
//
// The layers are the phone's (core/share/session.js): the car shows those of
// its car-safe set (model.js CAR_LAYER_KEYS) that the phone left on, and the
// car's LAYERS list changes the same shared set.
//
// It draws on the phone's GPU beside whatever the phone draws, so it renders
// only what changed: the follow view updates 12 to 20 times a second while
// the vehicle moves and stops when it stands (GPS wander is held still), the
// render target is held to a pixel budget, and moving layers tick slowly.
//
// It is also the car's GPS: the Android Auto screens (search, route preview,
// the routing card) ask this page through the same bridge to search, plan and
// follow a route with the navigator (core/nav/navigator.js, handed in by main
// through setNavigator), and the page draws the route, zooms in before each
// turn, and reports progress back about once a second. Parked, a small VEHICLE strip
// shows the car's own data (setCarInfo; off with setVehicleInfo(false)); it
// hides as soon as the car moves.
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
const MPH_PER_MPS = 2.236936;
const KMH_PER_MPS = 3.6;

/**
 * @param {HTMLElement} root
 * @param {object} [bootOpts]  main's settings; the car keeps its own light profile
 */
export async function mountShell(root, bootOpts = {}) {
  root.classList.add('argus-shell-car');
  const globeEl = h('div.argus-globe');
  const hud = h('div.argus-hud');
  root.append(globeEl, hud);

  // The phone's layers, within the car-safe set. They go into the share hash,
  // which main reads once this shell is mounted, so the first frame already
  // has them; with no phone session yet (a first run) the hash the app put
  // there (the car's last choice) stays.
  let ctl = null;
  let sharedLayers = null;
  try {
    sharedLayers = createSharedLayers({
      storage: window.localStorage,
      scope: CAR_LAYER_KEYS,
      apply: (changes) => ctl?.adoptLayers(changes),
    });
  } catch {
    sharedLayers = null; // storage blocked: the app's hash decides
  }
  const phoneLayers = sharedLayers?.read() ?? null;
  if (phoneLayers) {
    history.replaceState(
      null,
      '',
      `${location.pathname}${location.search}#v=1&layers=${phoneLayers.join(',')}`,
    );
  }
  // What the car means to show: a switch in its LAYERS list starts from this,
  // not from the menu, which lags while main is still switching layers on.
  let intended = new Set(
    phoneLayers ?? hashLayers(location.hash).filter((k) => CAR_LAYER_KEYS.includes(k)),
  );

  // The API exists before the globe does: early calls are kept, latest wins.
  // A search or a plan that arrives first is answered at once with an error
  // (the host retries on the driver's next tap).
  let shellApp = null;
  const early = {};
  window.argusCar = {
    pan: (...a) => ctl?.pan(...a),
    zoom: (...a) => ctl?.zoom(...a),
    tap: (...a) => ctl?.tap(...a),
    recenter: () => ctl?.recenter(),
    setLocation: (...a) => (ctl ? ctl.setLocation(...a) : (early.location = a)),
    setLayers: (keys) => (ctl ? ctl.setLayers(keys) : (early.layers = keys)),
    toggleLayer: (key, on) => {
      if (ctl) return ctl.toggleLayer(key, on);
      early.toggles = [...(early.toggles ?? []), [key, on]];
    },
    setVehicleInfo: (on) => (ctl ? ctl.setVehicleInfo(on) : (early.vehicleInfo = on)),
    setSpeedo: (on) => (ctl ? ctl.setSpeedo(on) : (early.speedo = on)),
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
  // The speed, small, bottom left of the free area: the car's own
  // speedometer when the app reads it, else the GPS; NO GPS when neither has
  // spoken for five seconds (an honest blank, not a frozen number).
  const speedValue = h('span.car-speedo__value', {}, '--');
  const speedUnit = h('span.car-speedo__unit', {}, units === 'imperial' ? 'MPH' : 'KM/H');
  const speedo = h('div.car-speedo', { role: 'status' }, speedValue, speedUnit);
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
  // maneuver banner (with its ETA line) is for the browser only. The VEHICLE
  // strip sits top left while parked.
  const inApp = Boolean(window.ArgusCarHost);
  const banner = createNavBanner({ units });
  const vehicleWidget = createVehicleWidget();
  const topLeft = h('div.car-topleft', {}, inApp ? null : banner.el, vehicleWidget.el);
  hud.append(topLeft, speedo, readout, notify, marker);

  // ---------------------------------------------------------------- state
  let fix = null; // { lat, lon, heading, speed, accuracy, t }
  let fromApp = false;
  let following = true;
  let rangeScale = 1;
  let viewMode = 'auto';
  let speedoOn = true; // the car's LAYERS list: SPEED
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
  let vehicleInfoOn = true; // the car's LAYERS list: VEHICLE INFO
  let touchedAt = 0; // the driver's last drag, pinch or tap on the map

  // ------------------------------------------------------------ following
  const view = { lat: 0, lon: 0, heading: 0, pitch: VIEW_MODES.auto.pitch, range: 0 };
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
  // the last nav update at its speed, for the heading at a crawl and the zoom.
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
    if (along !== null) {
      // GPS course is noise at a crawl: steer by the road instead.
      if (!((fix.speed || 0) > 3)) heading = bearingAlong(drive.ix, along) ?? heading;
      // Closer before a turn, wider on the open road (the automatic zoom).
      scale *= navZoom(navState?.progress?.distanceToStepM, fix.speed);
    }
    const target = followPose(
      { lat: pos.lat, lon: pos.lon, heading, speed: fix.speed },
      { scale, mode: viewMode },
    );
    // The vehicle in the middle of what the host leaves free (its routing
    // card and buttons cover the sides): aim the camera so it projects there.
    const c = middle();
    const aim = aimFor(target, {
      heading: target.heading,
      pitch: target.pitch,
      range: target.range,
      fov: cam.frustum?.fov,
      width: scene.canvas.clientWidth,
      height: scene.canvas.clientHeight,
      x: c.x,
      y: c.y,
    });
    if (aim) {
      target.lat = aim.lat;
      target.lon = aim.lon;
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
      // The turn, tilt and zoom ease; the aim does not: it is worked out
      // again for the eased view, so the vehicle stays in the middle of the
      // free area through a turn instead of swinging round it.
      const k = 1 - Math.exp(-dt / EASE_S);
      view.heading = wrap360(view.heading + angleDelta(view.heading, target.heading) * k);
      view.pitch = lerp(view.pitch, target.pitch, k);
      view.range = lerp(view.range, target.range, k);
      const held = aimFor(pos, {
        heading: view.heading,
        pitch: view.pitch,
        range: view.range,
        fov: cam.frustum?.fov,
        width: scene.canvas.clientWidth,
        height: scene.canvas.clientHeight,
        x: c.x,
        y: c.y,
      });
      view.lat = held?.lat ?? lerp(view.lat, target.lat, k);
      view.lon =
        held?.lon ?? wrap360(view.lon + angleDelta(view.lon, target.lon) * k + 180) - 180;
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
    touchedAt = performance.now() + Math.max(0, ms || 0);
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
    touchedAt = performance.now();
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

  // A tap on the car screen opens or folds the VEHICLE strip when it lands
  // there, else selects what is under it, through main's own picker (Pointer
  // Events on the canvas). A synthetic pointer cannot be captured, so capture
  // is skipped for just these two events.
  function tap(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (vehicleWidget.hit(x, y)) {
      vehicleWidget.toggle();
      return;
    }
    touchedAt = performance.now();
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
    if (!e.isTrusted) return;
    touchedAt = performance.now();
    setFollowing(false);
  });

  // Free look on the move: back to following the vehicle once the driver has
  // left the map alone for a while (model.js shouldResumeFollow). The zoom
  // the driver chose for the follow view stays; RECENTER resets it.
  function maybeResume(now) {
    const fresh = fix && now - fix.t < FIX_STALE_MS;
    if (
      shouldResumeFollow({
        following,
        speed: fresh ? fix.speed : NaN,
        idleMs: now - touchedAt,
        busy: Boolean(preview),
      })
    ) {
      viewSet = false;
      setFollowing(true);
    }
  }

  // ------------------------------------------------------------- location
  /**
   * A fix: `ageMs` is how old it already is (the app replays its last fix when
   * the page comes back, and a stored fix from before the drive is history,
   * not a position): an old one never replaces a newer one, and one past
   * FIX_STALE_MS shows NO GPS instead of a speed.
   */
  function setLocation(
    lat,
    lon,
    heading,
    speed,
    accuracy,
    ageMs = 0,
    { app: pushed = true } = {},
  ) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    if (pushed && !fromApp) {
      fromApp = true;
      stopGeolocation();
    }
    const t = performance.now() - (Number.isFinite(ageMs) ? clamp(ageMs, 0, 864e5) : 0);
    if (fix && t <= fix.t) return;
    const next = {
      lat,
      lon,
      heading: Number.isFinite(heading) ? heading : null,
      speed: Number.isFinite(speed) && speed >= 0 ? speed : null,
      accuracy: Number.isFinite(accuracy) ? accuracy : null,
      t,
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
    maybeResume(performance.now());
    startFollow();
    // In free look nothing renders while the map rests: the chevron is moved
    // to the new fix on its own (placeMarker), not left where it was.
    if (!following) placeMarker();
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
          Math.max(0, Date.now() - p.timestamp),
          { app: false },
        ),
      () => {},
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20_000 },
    );
  }, GEO_FALLBACK_MS);

  // The own-position chevron, kept on the vehicle: after every frame while
  // the view moves, and in free look (where the map rests and nothing
  // renders) on every fix and a few times a second while the vehicle moves,
  // carried forward along its course between fixes. Only the projection is
  // redone then: the map itself is not drawn again.
  const selfPos = new Cesium.Cartesian3();
  function placeMarker() {
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
  }
  scene.postRender.addEventListener(placeMarker);
  setInterval(() => {
    if (following || !fix || !((fix.speed || 0) > 0.5)) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    placeMarker();
  }, 200);

  // --------------------------------------------------------------- layers
  // Main's layer menu is kept off screen: its rows are pressed to switch
  // layers (as a person would) and read back for what is on.
  const rowStates = () =>
    menus
      .flatMap((m) => [...m.querySelectorAll('[data-layer]')])
      .map((row) => ({
        row,
        key: row.dataset.layer,
        on: row.getAttribute('aria-pressed') === 'true',
        loading: Boolean(row.querySelector('.is-load')),
      }));
  /** The layers on, or on their way. */
  const layersOn = () =>
    new Set(
      rowStates()
        .filter((s) => s.on || s.loading)
        .map((s) => s.key),
    );

  function reconcileLayers() {
    if (!wantLayers) return;
    const states = rowStates();
    for (const key of planLayerClicks(states, wantLayers)) {
      states.find((s) => s.key === key)?.row.click();
    }
  }

  // The car's LAYERS list offers the layers this build can show (a keyed
  // layer appears once the phone's proxy has its key) and shows which are
  // on: tell the app whenever either changes (rows change as layers load,
  // switch and fail; what settles is reported).
  let reportedLayers = '';
  let reportTimer = 0;
  function reportLayers() {
    clearTimeout(reportTimer);
    reportTimer = 0;
    const states = rowStates();
    if (!states.length) return;
    const keysOf = (list) => [...new Set(list.map((s) => s.key))].sort();
    const json = JSON.stringify({
      available: keysOf(states),
      on: keysOf(states.filter((s) => s.on || s.loading)),
    });
    if (json === reportedLayers) return;
    reportedLayers = json;
    toHost('layerState', json);
  }
  const reportSoon = () => {
    if (!reportTimer) reportTimer = setTimeout(reportLayers, 250);
  };
  const rowWatch =
    typeof MutationObserver === 'function' ? new MutationObserver(reportSoon) : null;

  /**
   * The car's layers: these (within its car-safe set) on, the others off.
   * `persist` writes the choice to the set the phone shares.
   */
  function chooseLayers(keys, { persist = true } = {}) {
    wantLayers = new Set([...keys].map(String).filter((k) => CAR_LAYER_KEYS.includes(k)));
    intended = new Set(wantLayers);
    reconcileLayers();
    if (persist) sharedLayers?.write([...wantLayers]);
    // Main may still be switching the start layers on one by one: settle
    // once more after that.
    clearTimeout(layerTimer);
    layerTimer = setTimeout(() => {
      reconcileLayers();
      reportLayers();
    }, 3000);
    reportSoon();
  }

  /** A preset from the car's LAYERS list: these layers and no others. */
  function setLayers(keys) {
    if (Array.isArray(keys)) chooseLayers(keys);
  }

  /** One switch in the car's LAYERS list. */
  function toggleLayer(key, on) {
    const k = String(key);
    if (!CAR_LAYER_KEYS.includes(k)) return;
    const next = new Set(intended);
    if (on) next.add(k);
    else next.delete(k);
    chooseLayers(next);
  }

  /** The phone changed the shared layers while the car runs: follow it. */
  function adoptLayers({ on = [], off = [] } = {}) {
    const next = new Set(intended);
    for (const k of off) next.delete(k);
    for (const k of on) next.add(k);
    chooseLayers(next, { persist: false });
  }

  // VEHICLE INFO in the car's LAYERS list: the VEHICLE strip at all.
  function setVehicleInfo(on) {
    vehicleInfoOn = on !== false;
    refreshVehicle();
  }

  // ----------------------------------------------------------------- view
  // AUTO or NORTH (the car's button; older builds saved '3d' or '2d': AUTO).
  function setView(mode) {
    const next = viewModeOf(mode);
    if (next === viewMode) return;
    viewMode = next;
    // Following, the view eases into the new pitch and heading; in free look,
    // the new view takes the map back to the vehicle.
    if (following) startFollow();
    else ctl.recenter();
  }

  // SPEED in the car's LAYERS list: the speed readout at all.
  function setSpeedo(on) {
    speedoOn = on !== false;
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
    // The tracking boxes keep clear of what sits top left (the browser's
    // banner, the VEHICLE strip while it shows).
    const top = topLeft.getBoundingClientRect().bottom - root.getBoundingClientRect().top;
    overlay.setInsets({
      top: Math.max(insets.top, topLeft.childElementCount ? top : 0),
      right: insets.right,
      bottom: insets.bottom,
      left: insets.left,
    });
  }

  // ----------------------------------------------------------- readouts
  const pad2 = (n) => String(n).padStart(2, '0');
  // Each cell is written only when its text changes: no style or layout work
  // for an unchanged strip, once a second.
  const put = (el, text) => {
    if (el.textContent !== text) el.textContent = text;
  };
  function refreshStatus() {
    // Backgrounded (the browser ?shell=car fallback): skip the repaint. The
    // next visible tick catches the fix up, so nothing is lost.
    if (typeof document !== 'undefined' && document.hidden) return;
    const now = performance.now();
    const speed = speedNow(now);
    const located = Boolean(fix) && now - fix.t < FIX_STALE_MS;
    speedo.hidden = !speedoOn;
    put(
      speedValue,
      Number.isFinite(speed)
        ? String(Math.round(speed * (units === 'imperial' ? MPH_PER_MPS : KMH_PER_MPS)))
        : '--',
    );
    // No position for five seconds: say so where the unit was.
    put(speedUnit, located ? (units === 'imperial' ? 'MPH' : 'KM/H') : 'NO GPS');
    speedo.classList.toggle('is-stale', !located);
    refreshVehicle();
  }

  // ------------------------------------------------------------- vehicle
  // The VEHICLE strip: shown once the car has stood still for three seconds
  // (its own speedometer when the app reads it, else the GPS), hidden the
  // moment it moves, never over an active route, and not at all when VEHICLE
  // INFO is off in the car's LAYERS list.
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
    const view =
      carInfo && vehicleInfoOn ? vehicleView(carInfo, { units, imperialGallon }) : null;
    const was = vehicleWidget.shown;
    if (still && !routing && view?.known) vehicleWidget.show(vehicleChip(view));
    else vehicleWidget.hide();
    if (was !== vehicleWidget.shown) layoutOverlay();
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

  setInterval(() => {
    refreshStatus();
    maybeResume(performance.now());
  }, 1000);
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
  // Small and out of the way: two rows, one on a route (and only where the
  // routing card leaves room for it beside the vehicle), none while
  // previewing routes.
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
    const max = drive ? 1 : 2;
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
      h('span.car-row__name', {}, String(name).slice(0, 24)),
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
    toggleLayer,
    adoptLayers,
    setVehicleInfo,
    setSpeedo,
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
      layersOn: [...layersOn()].sort(),
      insets: { ...insets },
      nav: navState?.status ?? (nav ? 'idle' : 'offline'),
      route: drive ? drive.route.id : null,
      preview: preview ? preview.routes.map((r) => r.id) : null,
      vehicle: vehicleWidget.shown,
      vehicleOpen: vehicleWidget.open,
      vehicleInfo: vehicleInfoOn,
      speedo: speedoOn ? speedValue.textContent + ' ' + speedUnit.textContent : null,
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
        rowWatch?.observe(el, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ['aria-pressed', 'class'],
        });
        reconcileLayers();
        reportLayers();
      }
    },
    attachOverlay(o) {
      overlay = o;
      // Boxes on the nearest few contacts; no viewport frame and corner
      // readouts (state, object count, SIG / TRK) on a car screen.
      o.setOptions({ density: 'low', frame: false });
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
  for (const [key, on] of early.toggles ?? []) toggleLayer(key, on);
  if (early.vehicleInfo !== undefined) setVehicleInfo(early.vehicleInfo);
  if (early.speedo !== undefined) setSpeedo(early.speedo);
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
