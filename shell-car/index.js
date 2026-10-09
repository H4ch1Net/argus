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
  FOLLOW_PITCH_DEG,
  angleDelta,
  clamp,
  courseFor,
  destination,
  followPose,
  formatDistance,
  formatHeading,
  formatSpeed,
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
// list. A heading-up 3D view follows the vehicle, tilted 45 degrees at 3 to 8
// km depending on speed. Driver-distraction rules shape the UI: the map, a
// status strip (time, speed, heading), the nearest contacts in large type and
// the tracking boxes; no menus, no text entry, no video. Main still mounts
// its components; the slots this shell has no place for are ignored.
//
// Also runs in any browser at ?shell=car (navigator.geolocation then drives
// it, and a drag on the globe leaves follow mode), which is how to try it
// without a car.

const EASE_S = 0.35; // how quickly the follow view settles on a new fix
const FRAME_MS = 1000 / 20; // follow-view updates per second, at most
const DEAD_RECKON_S = 2; // carry a fix forward along its course this long
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
    state: () => ctl?.state() ?? null,
  };

  // The car display is a second screen on the phone's GPU, rendering while the
  // phone may render too: the lightest tier, about 1.25 device pixels per CSS
  // pixel (not below 0.86, so the thermal ladder's 0.7 step still lowers it).
  const dpr = window.devicePixelRatio || 1;
  const app = await bootGlobe(globeEl, {
    onContextChange: bootOpts.onContextChange,
    tier: 'minimal',
    profile: {
      resolutionScale: clamp(1.25 / dpr, 0.86, 1),
      targetFrameRate: 30,
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
  const cells = {
    utc: cell('UTC'),
    local: cell('LCL'),
    speed: cell('SPD'),
    heading: cell('HDG'),
    mode: cell('MODE'),
  };
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
  hud.append(status, readout, notify, marker);

  // ---------------------------------------------------------------- state
  let fix = null; // { lat, lon, heading, speed, accuracy, t }
  let fromApp = false;
  let following = true;
  let rangeScale = 1;
  let overlay = null;
  let summary = null;
  let wantLayers = null;
  let layerTimer = null;
  const menus = []; // main's layer menu: kept off screen, driven by setLayers
  const insets = { top: 0, right: 0, bottom: 0, left: 0 };

  // ------------------------------------------------------------ following
  const view = { lat: 0, lon: 0, heading: 0, range: 0 };
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
    hpr.pitch = Cesium.Math.toRadians(FOLLOW_PITCH_DEG);
    hpr.range = view.range;
    cam.lookAt(centre, hpr);
    cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
    scene.requestRender();
  }

  function startFollow() {
    if (!raf && following && fix) raf = requestAnimationFrame(tick);
  }

  function tick(t) {
    raf = 0;
    if (!following || !fix) return;
    if (t - lastTick < FRAME_MS) {
      raf = requestAnimationFrame(tick);
      return;
    }
    const dt = lastTick ? Math.min(0.5, (t - lastTick) / 1000) : FRAME_MS / 1000;
    lastTick = t;
    const now = performance.now();
    const pos = predicted(now);
    const target = followPose(
      { lat: pos.lat, lon: pos.lon, heading: fix.heading, speed: fix.speed },
      { scale: rangeScale },
    );
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
        pitch: FOLLOW_PITCH_DEG,
        duration: 2,
      });
    } else if (now >= acquiringUntil) {
      const k = 1 - Math.exp(-dt / EASE_S);
      view.lat = lerp(view.lat, target.lat, k);
      view.lon = wrap360(view.lon + angleDelta(view.lon, target.lon) * k + 180) - 180;
      view.heading = wrap360(view.heading + angleDelta(view.heading, target.heading) * k);
      view.range = lerp(view.range, target.range, k);
      applyView();
    }
    const settled =
      Math.abs(view.lat - target.lat) < 1e-6 &&
      Math.abs(angleDelta(view.lon, target.lon)) < 1e-6 &&
      Math.abs(angleDelta(view.heading, target.heading)) < 0.05 &&
      Math.abs(view.range - target.range) < 1;
    if (!settled || (fix.speed || 0) > 0.3 || now < acquiringUntil) {
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

  function setLayers(keys) {
    if (!Array.isArray(keys)) return;
    wantLayers = new Set(keys.map(String));
    reconcileLayers();
    // Main switches the link's layers on one by one as the scene starts:
    // settle once more after that.
    clearTimeout(layerTimer);
    layerTimer = setTimeout(reconcileLayers, 3000);
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
  function refreshStatus() {
    // Backgrounded (the browser ?shell=car fallback): skip the repaint. The
    // next visible tick catches the clock and fix up, so nothing is lost.
    if (typeof document !== 'undefined' && document.hidden) return;
    const now = new Date();
    cells.utc.value.textContent = `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}`;
    cells.local.value.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const fresh = fix && performance.now() - fix.t < FIX_STALE_MS;
    cells.speed.value.textContent = formatSpeed(fresh ? fix.speed : NaN, units);
    cells.heading.value.textContent = formatHeading(fresh ? fix.heading : NaN);
    cells.mode.value.textContent = !fix ? 'NO FIX' : following ? 'FOLLOW' : 'FREE';
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
    for (const c of nearestContacts(contacts, here, hub?.target ? 2 : 3)) {
      rows.push(
        row(
          pad2(c.id ?? 0),
          c.label || layerCode(c.key),
          layerCode(c.key),
          c.distanceM,
          c.bearingDeg,
        ),
      );
    }
    readout.replaceChildren(...rows);
    readout.hidden = rows.length === 0;
  }

  function row(id, name, kind, distance, bearing, isHub = false) {
    const rel =
      Number.isFinite(bearing) && fix ? wrap360(bearing - (fix.heading ?? 0)) : null;
    return h(
      `div.car-row${isHub ? '.is-hub' : ''}`,
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
    state: () => ({
      following,
      rangeScale,
      fix: fix && { ...fix },
      layers: wantLayers ? [...wantLayers] : null,
      insets: { ...insets },
    }),
  };
  if (early.insets) setInsets(...early.insets);
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
  };
}

export const shellName = 'car';
