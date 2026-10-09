import * as Cesium from 'cesium';
import { acquireContinuousRender, releaseContinuousRender } from '../scene/renderMode.js';
import { destinationImage, puckImage } from '../ui/navGlyphs.js';
import { angleDiff, cumulative, lineBBox, pointAlong } from './geo.js';
import { createRouteLines } from './routeLines.js';

// The navigator on the globe (browser only; the terminal never imports it):
// the planned routes and the one being driven as ground lines (bright ahead,
// grey behind, TomTom jams in red, alternatives dim), the destination marker,
// the vehicle puck, and the follow camera (heading up, tilted, looking ahead).
//
// Cost: the line geometry is built only when the routes change (a plan, a
// reroute: core/nav/routeLines.js); progress, the chosen alternative and the
// start of the drive only recolour pieces of it. The follow camera runs in
// preRender at the paced frame rate (core/scene/renderMode.js) with scratch
// objects only: nothing is allocated per frame.

const AHEAD = Cesium.Color.WHITE;
const BEHIND = Cesium.Color.fromCssColorString('#7a7a7a').withAlpha(0.9);
const ALT = Cesium.Color.fromCssColorString('#c3c3c3').withAlpha(0.45);
const JAM = Cesium.Color.fromCssColorString('#fc3e38');
const NONE = Cesium.Color.TRANSPARENT;
const ENTRY_S = 1.2;
const PITCH = Cesium.Math.toRadians(-38);
const M_PER_DEG = 111_320;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {ReturnType<import('./navigator.js').createNavigator>} nav
 * @param {{ follow?: boolean, fps?: number, showPuck?: () => boolean,
 *   onFollowChange?: (on: boolean) => void, onFollowStart?: () => void }} [opts]
 *   follow false: never drive the camera (the car shell follows the vehicle itself)
 */
export function createNavView(
  viewer,
  nav,
  { follow = true, fps = 30, showPuck = () => true, onFollowChange, onFollowStart } = {},
) {
  const scene = viewer.scene;
  const cam = viewer.camera;
  let state = nav.state;
  let route = null;
  let routes = null; // the drawn set (built once per set)
  let cum = null;

  // --- lines ---------------------------------------------------------------------
  const lines = createRouteLines(scene);
  const jamAt = (r, piece) =>
    (r?.traffic ?? []).some((s) => piece.index >= s.from && piece.index < s.to);
  const driving = () =>
    state.status === 'navigating' ||
    state.status === 'rerouting' ||
    state.status === 'arrived';
  function colorOf(ri, piece) {
    const r = routes?.[ri];
    if (!r || state.status === 'idle') return NONE;
    if (!driving()) return r === route ? (jamAt(r, piece) ? JAM : AHEAD) : ALT;
    if (r !== route) return NONE;
    if (piece.to <= fixAlong) return BEHIND;
    return jamAt(r, piece) ? JAM : AHEAD;
  }

  // --- markers -------------------------------------------------------------------
  const billboards = scene.primitives.add(new Cesium.BillboardCollection({ scene }));
  const destMark = billboards.add({
    show: false,
    image: destinationImage(),
    width: 40,
    height: 52,
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });
  const puck = billboards.add({
    show: false,
    image: puckImage(),
    width: 30,
    height: 30,
    alignedAxis: Cesium.Cartesian3.UNIT_Z,
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  });
  const scratchPos = new Cesium.Cartesian3();

  function placePuck(lat, lon, headingDeg) {
    const on = showPuck() && state.status !== 'idle' && state.status !== 'previewing';
    puck.show = on;
    if (!on) return;
    puck.position = Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      0,
      Cesium.Ellipsoid.WGS84,
      scratchPos,
    );
    puck.rotation = -Cesium.Math.toRadians(headingDeg || 0);
  }

  // --- follow camera -------------------------------------------------------------
  let following = false;
  let claimed = false;
  const view = { along: 0, heading: 0, range: 600, lat: 0, lon: 0, set: false };
  let fixAlong = 0;
  let fixAt = 0;
  let fixSpeed = 0;
  let lastFrame = 0;
  let enterUntil = 0;
  const hpr = new Cesium.HeadingPitchRange(0, PITCH, 600);
  const carto = new Cesium.Cartographic();
  const centre = new Cesium.Cartesian3();
  const here = {};
  const ahead = {};

  function setFollow(on) {
    const next = Boolean(on) && follow;
    if (next === following) return;
    following = next;
    if (following && !claimed) {
      onFollowStart?.();
      acquireContinuousRender(scene, fps);
      claimed = true;
      view.set = false;
    } else if (!following && claimed) {
      releaseContinuousRender(scene, fps);
      claimed = false;
    }
    onFollowChange?.(following);
  }

  function frame() {
    if (!following || !route || !cum) return;
    const now = performance.now();
    const dt = lastFrame ? Math.min(0.5, (now - lastFrame) / 1000) : 1 / fps;
    lastFrame = now;
    const progress = state.progress;
    const total = cum[cum.length - 1];
    const off = progress?.offRoute || state.status === 'rerouting';
    let lat;
    let lon;
    let heading;
    if (off && nav.lastFix) {
      lat = nav.lastFix.lat;
      lon = nav.lastFix.lon;
      heading = Number.isFinite(nav.lastFix.heading) ? nav.lastFix.heading : view.heading;
    } else {
      // Dead-reckon along the route between fixes (at most 2 s), eased.
      const moving = state.status === 'navigating' ? fixSpeed : 0;
      const predicted = Math.min(
        total,
        fixAlong + moving * Math.min(2, (now - fixAt) / 1000),
      );
      if (!view.set || Math.abs(predicted - view.along) > 300) view.along = predicted;
      else view.along += (predicted - view.along) * (1 - Math.exp(-dt / 0.25));
      const p = pointAlong(route.geometry, cum, view.along, here);
      lat = p.lat;
      lon = p.lon;
      heading = pointAlong(route.geometry, cum, view.along + 25, ahead).heading;
    }
    const range = Math.min(1500, Math.max(320, 300 + fixSpeed * 32));
    let entering = false;
    if (!view.set) {
      view.heading = heading;
      view.range = range;
      view.set = true;
      entering = true;
    } else {
      view.heading =
        (view.heading +
          angleDiff(view.heading, heading) * (1 - Math.exp(-dt / 0.6)) +
          360) %
        360;
      view.range += (range - view.range) * (1 - Math.exp(-dt / 1.5));
    }
    view.lat = lat;
    view.lon = lon;
    placePuck(lat, lon, view.heading);
    // Look at a point ahead of the vehicle, so it sits low on the screen.
    const lookAhead = view.range * 0.32;
    const h = Cesium.Math.toRadians(view.heading);
    const cLat = lat + (Math.cos(h) * lookAhead) / M_PER_DEG;
    const cLon =
      lon + (Math.sin(h) * lookAhead) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
    Cesium.Cartographic.fromDegrees(cLon, cLat, 0, carto);
    const ground = scene.globe?.getHeight?.(carto) ?? 0;
    Cesium.Cartesian3.fromDegrees(cLon, cLat, ground, Cesium.Ellipsoid.WGS84, centre);
    hpr.heading = h;
    hpr.pitch = PITCH;
    hpr.range = view.range;
    if (entering) {
      // Fly into the follow view first (once per follow), then track it.
      cam.flyToBoundingSphere(
        new Cesium.BoundingSphere(Cesium.Cartesian3.clone(centre), 0),
        {
          offset: new Cesium.HeadingPitchRange(h, PITCH, view.range),
          duration: ENTRY_S,
        },
      );
      enterUntil = now + ENTRY_S * 1000 + 50;
      return;
    }
    if (now < enterUntil) return;
    cam.lookAt(centre, hpr);
    cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
  const removePreRender = scene.preRender.addEventListener(frame);

  // A drag (not a tap) or a wheel on the globe hands the camera back.
  const canvas = scene.canvas;
  let press = null;
  const onDown = (e) => {
    press = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onMove = (e) => {
    if (!press || !following || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) setFollow(false);
  };
  const onUp = () => {
    press = null;
  };
  const onWheel = () => following && setFollow(false);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: true });

  // --- state ---------------------------------------------------------------------
  function onState(s) {
    const prev = state;
    state = s;
    const nextRoutes =
      s.status === 'idle' ? null : (s.routes ?? (s.route ? [s.route] : null));
    const nextRoute = s.status === 'idle' ? null : (s.route ?? null);
    if (nextRoute !== route) {
      cum = nextRoute ? cumulative(nextRoute.geometry) : null;
      fixAlong = 0;
    }
    route = nextRoute;
    // New geometry only for a new set of routes (a plan, a reroute).
    if (nextRoutes !== routes) {
      routes = nextRoutes;
      lines.build(routes ?? []);
    }
    const d = s.destination;
    destMark.show = Boolean(d) && s.status !== 'idle';
    if (d && prev.destination !== d) {
      destMark.position = Cesium.Cartesian3.fromDegrees(d.lon, d.lat);
    }
    const pr = s.progress;
    if (
      pr &&
      pr !== prev.progress &&
      (s.status === 'navigating' || s.status === 'rerouting' || s.status === 'arrived')
    ) {
      fixAlong = pr.alongM ?? fixAlong;
      fixAt = performance.now();
      fixSpeed = Number(nav.lastFix?.speed) || 0;
      if (!following) placePuck(pr.snapped.lat, pr.snapped.lon, nav.lastFix?.heading);
    }
    if (
      s.status === 'navigating' &&
      prev.status !== 'navigating' &&
      prev.status !== 'rerouting'
    )
      setFollow(true);
    if (s.status === 'idle' || s.status === 'previewing' || s.status === 'planning') {
      setFollow(false);
      puck.show = false;
    }
    lines.paint(colorOf);
    scene.requestRender();
  }
  const unsubscribe = nav.subscribe(onState);
  onState(nav.state);

  return {
    /**
     * Fly to show the previewed routes (or the destination) clear of the
     * panels: `top` and `bottom` are the fractions of the screen height they
     * cover (the desktop's preview hangs from the top, the phone's sits low).
     */
    frameRoutes({ top = 0.12, bottom = 0.12 } = {}) {
      const all = (routes ?? []).flatMap((r) => r.geometry);
      const d = state.destination;
      if (!all.length && !d) return;
      const pts = all.length ? all : [[d.lon, d.lat]];
      const [w, s, e, n] = lineBBox(pts);
      const t = Math.min(0.6, Math.max(0, top));
      const b = Math.min(0.6, Math.max(0, bottom));
      const height = Math.max(0.006, n - s) * 1.15;
      const full = height / Math.max(0.2, 1 - t - b);
      const mid = (n + s) / 2;
      const padLon = Math.max(0.004, (e - w) * 0.2);
      cam.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          w - padLon,
          Math.max(-89, mid - height / 2 - b * full),
          e + padLon,
          Math.min(89, mid + height / 2 + t * full),
        ),
        duration: 1.2,
      });
    },
    /** Back to following the vehicle (RECENTER). */
    recenter: () =>
      setFollow(state.status === 'navigating' || state.status === 'rerouting'),
    setFollow,
    get following() {
      return following;
    },
    destroy() {
      unsubscribe();
      setFollow(false);
      removePreRender();
      lines.destroy();
      scene.primitives.remove(billboards);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
