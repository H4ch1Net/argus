import * as Cesium from 'cesium';
import { createGroundBatch } from '../layers/surveillance/groundBatch.js';
import { acquireContinuousRender, releaseContinuousRender } from '../scene/renderMode.js';
import { INK } from '../ui/palette.js';
import { selfIconImage, selfPulseImage, SELF_ICONS } from '../ui/selfIcons.js';

// The user's own marker on the globe (core/geo/selfPosition.js feeds it): the
// chosen ctOS icon turned to the heading and drawn over everything, a subtle
// accuracy ring on the ground, the ctOS bracket pulse while locating, and
// follow-me (the camera rides with the marker, north up or heading up).
//
// Smooth without waste: between fixes the marker is carried forward along
// its course (dead reckoning, at most 2.2 s) and eased onto each new fix, so
// 1 Hz GPS reads as continuous motion. Frames are claimed from the shared
// pacer only while it moves, turns or pulses; a still marker costs nothing.
// The ring is ground geometry (it drapes on terrain), rebuilt only when the
// fix moves or its accuracy changes enough to see, and hidden at driving
// speed, where it would trail the marker.

const ICON_PX = 32;
const PULSE_PX = 46;
const PULSE_MS = 1400;
const EASE_S = 0.22; // position ease toward the (dead-reckoned) fix
const TURN_S = 0.18; // heading ease
const DEAD_RECKON_S = 2.2; // GPS at 1 Hz, with room for a late fix
const SNAP_M = 250; // farther than this: jump instead of gliding across town
const STILL_MPS = 0.6;
const RING_MAX_MPS = 3;
const RING_SEGMENTS = 64;
const RING_MAX_M = 250_000;
const FOLLOW_MIN_RANGE_M = 60;
const FOLLOW_MAX_RANGE_M = 3_000_000;
const HEADING_UP_PITCH = -50; // degrees: the tilt heading-up takes on entry
const HEADING_UP_S = 0.5; // heading-up turn ease
const DRAG_PX = 12; // a press that moves this far is a drag, not a tap
const SCALE = new Cesium.NearFarScalar(2e5, 1, 2e7, 0.65);

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const angleDelta = (a, b) => ((b - a + 540) % 360) - 180;
const wrap360 = (a) => ((a % 360) + 360) % 360;

/** The point d metres from (lat, lon) on a bearing: [lat, lon]. */
function destination(lat, lon, bearing, d) {
  const a = d / R;
  const b = rad(bearing);
  const p1 = rad(lat);
  const l1 = rad(lon);
  const p2 = Math.asin(
    Math.sin(p1) * Math.cos(a) + Math.cos(p1) * Math.sin(a) * Math.cos(b),
  );
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(a) * Math.cos(p1),
      Math.cos(a) - Math.sin(p1) * Math.sin(p2),
    );
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

function metresBetween(aLat, aLon, bLat, bLon) {
  const x = rad(bLon - aLon) * Math.cos(rad((aLat + bLat) / 2));
  const y = rad(bLat - aLat);
  return Math.hypot(x, y) * R;
}

/** Flat [lon, lat, ...] ring of a circle (open: the first point is not repeated). */
function circleRing(lat, lon, radius) {
  const out = [];
  for (let i = 0; i < RING_SEGMENTS; i += 1) {
    const [la, lo] = destination(lat, lon, (i * 360) / RING_SEGMENTS, radius);
    out.push(lo, la);
  }
  return out;
}

// Heading-up billboards align "up" to local north (as core/layers/sdk/renderers.js).
function northAt(lonDeg, latDeg, result) {
  const lon = rad(lonDeg);
  const lat = rad(latDeg);
  result.x = -Math.sin(lat) * Math.cos(lon);
  result.y = -Math.sin(lat) * Math.sin(lon);
  result.z = Math.cos(lat);
  return result;
}

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ icon?: string, fps?: number, onDrag?: () => void, onTouch?: () => void,
 *   onTwist?: () => void, onYield?: () => void, isBusy?: () => boolean }} [opts]
 *   onDrag: the map was dragged (or a flight took the view) while following;
 *   onTouch: any press on the map; onTwist: the map was turned heading-up;
 *   onYield: something else took the camera; isBusy: true while something
 *   else drives the camera (navigation, the cockpit).
 */
export function createSelfMarker(
  viewer,
  { icon = SELF_ICONS[0].id, fps = 30, onDrag, onTouch, onTwist, onYield, isBusy } = {},
) {
  const scene = viewer.scene;
  const camera = viewer.camera;
  const coll = scene.primitives.add(new Cesium.BillboardCollection());
  const common = {
    position: Cesium.Cartesian3.ZERO,
    show: false,
    disableDepthTestDistance: Number.POSITIVE_INFINITY, // always on top
    scaleByDistance: SCALE,
    verticalOrigin: Cesium.VerticalOrigin.CENTER,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
  };
  const pulse = coll.add({ ...common });
  const mark = coll.add({ ...common });
  const pulseImg = selfPulseImage();
  pulse.setImage(pulseImg.id, pulseImg.image);

  const WHITE = Cesium.Color.WHITE;
  const STALE = Cesium.Color.fromCssColorString(INK.muted).withAlpha(0.9);
  const pulseColor = Cesium.Color.WHITE.clone();
  const ringFill = Cesium.Color.WHITE.withAlpha(0.08);
  const ringLine = Cesium.Color.WHITE.withAlpha(0.55);
  const ringFillStale = Cesium.Color.fromCssColorString(INK.muted).withAlpha(0.06);
  const ringLineStale = Cesium.Color.fromCssColorString(INK.muted).withAlpha(0.45);

  const pos = new Cesium.Cartesian3();
  const north = new Cesium.Cartesian3();
  const toCam = new Cesium.Cartesian3();
  const carto = new Cesium.Cartographic();

  const metaOf = (id) => SELF_ICONS.find((i) => i.id === id) ?? SELF_ICONS[0];
  let meta = metaOf(icon);
  let imageKey = '';
  let fix = null;
  let rx = 0; // performance.now() when the fix arrived
  let live = false;
  let locating = false;
  let pulseT0 = 0;
  let groundH = 0;
  const disp = { lat: 0, lon: 0, heading: 0, has: false };
  let lastStep = 0;
  let animating = false;
  let claimed = false;
  let destroyed = false;

  // -------------------------------------------------------------- ring
  let ring = null; // { lat, lon, r, live }
  const ringBatch = createGroundBatch(scene, {
    debounceMs: 150,
    scaleFor: (h) => (ring && h <= Math.max(4000 * ring.r, 25_000) ? 1 : 0),
    collect: () => {
      if (!ring) return { fills: [], lines: [] };
      const path = circleRing(ring.lat, ring.lon, ring.r);
      return {
        fills: [{ ring: path, color: ring.live ? ringFill : ringFillStale }],
        lines: [
          { path, loop: true, width: 1.5, color: ring.live ? ringLine : ringLineStale },
        ],
      };
    },
  });
  ringBatch.setVisible(false);

  // Fast while fixes keep coming at speed; once they stop (parked, a tunnel)
  // the ring comes back at the last fix.
  const fast = () =>
    (fix.speed ?? 0) >= RING_MAX_MPS && performance.now() - rx < DEAD_RECKON_S * 1000;

  function updateRing() {
    const r = fix?.accuracy;
    const show = Boolean(fix) && Number.isFinite(r) && r > 0 && !fast();
    if (!show) {
      ringBatch.setVisible(false);
      return;
    }
    const radius = Math.min(r, RING_MAX_M);
    const moved = ring ? metresBetween(ring.lat, ring.lon, fix.lat, fix.lon) : Infinity;
    const resized = ring ? Math.abs(radius - ring.r) / ring.r : Infinity;
    // Rebuild only for a change that shows: a fifth of the radius, or a new tint.
    if (
      !ring ||
      moved > Math.max(1.5, radius * 0.2) ||
      resized > 0.15 ||
      ring.live !== live
    ) {
      ring = { lat: fix.lat, lon: fix.lon, r: radius, live };
      ringBatch.markDirty();
    }
    ringBatch.setVisible(true);
  }

  // ------------------------------------------------------------- frames
  function claim(on) {
    if (on === claimed || destroyed) return;
    claimed = on;
    if (on) acquireContinuousRender(scene, fps);
    else releaseContinuousRender(scene, fps);
  }

  function sampleGround() {
    if (!fix) return;
    Cesium.Cartographic.fromDegrees(fix.lon, fix.lat, 0, carto);
    const hgt = scene.globe?.getHeight?.(carto);
    if (Number.isFinite(hgt)) groundH = hgt;
  }

  function restyle() {
    const cue = Number.isFinite(fix?.heading);
    const key = `${meta.id}|${cue}`;
    if (key !== imageKey) {
      const img = selfIconImage(meta.id, { cue });
      mark.setImage(img.id, img.image);
      mark.scale = ICON_PX / img.px;
      imageKey = key;
    }
    mark.color = live ? WHITE : STALE;
  }

  // Advance the display one step (idempotent within a frame: the follow
  // camera asks again after the marker's own preRender step).
  function advance() {
    const t = performance.now();
    if (t - lastStep < 1) return;
    const dt = lastStep ? Math.min(0.25, (t - lastStep) / 1000) : 1 / 60;
    lastStep = t;
    if (!fix || !disp.has) return;
    let tLat = fix.lat;
    let tLon = fix.lon;
    const speed = fix.speed ?? 0;
    const moving = speed > STILL_MPS && Number.isFinite(fix.heading);
    const ahead = moving ? speed * Math.min(DEAD_RECKON_S, (t - rx) / 1000) : 0;
    if (ahead > 0.05) [tLat, tLon] = destination(fix.lat, fix.lon, fix.heading, ahead);
    const k = 1 - Math.exp(-dt / EASE_S);
    const dLat = tLat - disp.lat;
    const dLon = angleDelta(disp.lon, tLon);
    disp.lat += dLat * k;
    disp.lon = wrap360(disp.lon + dLon * k + 180) - 180;
    const wantHeading = Number.isFinite(fix.heading) ? fix.heading : disp.heading;
    const dH = angleDelta(disp.heading, wantHeading);
    disp.heading = wrap360(disp.heading + dH * (1 - Math.exp(-dt / TURN_S)));
    const coasting = moving && (t - rx) / 1000 < DEAD_RECKON_S;
    const still = Math.abs(dLat) < 1e-7 && Math.abs(dLon) < 1e-7 && Math.abs(dH) < 0.3;
    animating = coasting || !still;
  }

  function draw() {
    if (!fix || !disp.has) {
      mark.show = false;
      pulse.show = false;
      return;
    }
    Cesium.Cartesian3.fromDegrees(
      disp.lon,
      disp.lat,
      groundH,
      Cesium.Ellipsoid.WGS84,
      pos,
    );
    // Depth testing is off, so hide it ourselves behind the Earth's limb.
    Cesium.Cartesian3.subtract(camera.positionWC, pos, toCam);
    const visible = Cesium.Cartesian3.dot(toCam, pos) > 0;
    mark.show = visible;
    mark.position = pos;
    // Shapes that point turn always; a heading mark turns only when known.
    if (meta.directional || (meta.cue && Number.isFinite(fix.heading))) {
      mark.alignedAxis = northAt(disp.lon, disp.lat, north);
      mark.rotation = -rad(disp.heading);
    } else {
      mark.alignedAxis = Cesium.Cartesian3.ZERO;
      mark.rotation = 0;
    }
    pulse.show = visible && locating;
    if (pulse.show) {
      const phase = ((performance.now() - pulseT0) % PULSE_MS) / PULSE_MS;
      pulse.position = pos;
      pulse.scale = (PULSE_PX / pulseImg.px) * (0.75 + 1.6 * phase);
      pulseColor.alpha = 0.9 * (1 - phase) ** 1.5;
      pulse.color = pulseColor;
    }
  }

  function frame() {
    if (destroyed) return;
    const was = animating;
    advance();
    draw();
    if (was && !animating) updateRing(); // came to rest: the ring may return
    claim(animating || locating);
  }
  const removePreRender = scene.preRender.addEventListener(frame);
  // After a flight the terrain under the marker loads: sit it on the ground.
  const removeMoveEnd = camera.moveEnd.addEventListener(() => {
    const before = groundH;
    sampleGround();
    if (groundH !== before) scene.requestRender();
  });

  // ------------------------------------------------------------ follow
  // Follow-me (core/geo/follow.js decides the mode; selfPosition passes it
  // in). Once per frame, after the gestures have moved the camera, the camera
  // is set to look at the marker from where it is now: the user's distance,
  // tilt and turn are kept, so a pinch changes how close it follows and a
  // twist turns the map; heading-up turns the map to the way you travel and
  // tilts it once to see ahead, with the marker low on the screen. A
  // one-finger (or left-button) drag pauses following (GEO offers RECENTER),
  // and so does a flight the app starts elsewhere (search, a place); one that
  // ends over the marker (north up, tilt) does not. FOLLOW on a contact or
  // the cockpit takes the camera: following ends.
  let fmode = 'off';
  let fpaused = false;
  let removeFollowFrame = null;
  let lastTarget = null; // what the camera looked at after the last frame
  let lastHeading = null; // the heading it was left with (radians)
  let pitchGoal = null; // heading-up tilts once, on entry
  let flightSeen = false;
  let followT = 0;
  const target = new Cesium.Cartesian3();
  const hpr = new Cesium.HeadingPitchRange(0, -Math.PI / 2, 1000);
  const look = new Cesium.Cartesian3();

  const busy = () => {
    try {
      return Boolean(isBusy?.());
    } catch {
      return false;
    }
  };
  const inFlight = () => Boolean(camera._currentFlight);

  /** Where the follow camera aims: the marker, or ahead of it heading-up. */
  function aimPoint(range, pitch, result) {
    let lat = disp.lat;
    let lon = disp.lon;
    if (fmode === 'heading') {
      // Look past the marker, so it sits in the lower part of the screen.
      const ahead = range * Math.cos(pitch) * 0.3;
      if (ahead > 1) [lat, lon] = destination(lat, lon, disp.heading, ahead);
    }
    return Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      groundH,
      Cesium.Ellipsoid.WGS84,
      result,
    );
  }

  /**
   * How far the view's middle is from where following would aim (left in
   * `target`), as a share of the distance to it.
   */
  function offCentre() {
    Cesium.Cartesian3.fromDegrees(
      disp.lon,
      disp.lat,
      groundH,
      Cesium.Ellipsoid.WGS84,
      target,
    );
    aimPoint(Cesium.Cartesian3.distance(camera.positionWC, target), camera.pitch, target);
    const d = Cesium.Cartesian3.distance(camera.positionWC, target);
    if (!(d > 0)) return 0;
    Cesium.Cartesian3.multiplyByScalar(camera.directionWC, d, look);
    Cesium.Cartesian3.add(camera.positionWC, look, look);
    return Cesium.Cartesian3.distance(look, target) / d;
  }

  const clampRange = (r) =>
    Math.min(FOLLOW_MAX_RANGE_M, Math.max(FOLLOW_MIN_RANGE_M, Number(r) || 1000));

  function followFrame() {
    if (destroyed || fmode === 'off' || fpaused || !fix || !disp.has) return;
    if (busy()) {
      lastTarget = null; // navigation or the cockpit drives the camera
      return;
    }
    if (inFlight()) {
      flightSeen = true;
      return;
    }
    if (flightSeen) {
      // A flight ended: one that landed away from the marker took the view.
      flightSeen = false;
      lastTarget = null;
      if (offCentre() > 0.2) {
        onDrag?.();
        return;
      }
    }
    advance();
    const t = performance.now();
    const dt = followT ? Math.min(0.25, (t - followT) / 1000) : 1 / 60;
    followT = t;
    const from = lastTarget ?? aimPoint(0, 0, target);
    const range = clampRange(Cesium.Cartesian3.distance(camera.positionWC, from));
    let heading = camera.heading;
    let pitch = camera.pitch;
    if (fmode === 'heading') {
      if (
        lastHeading !== null &&
        Math.abs(angleDelta(deg(lastHeading), deg(heading))) > 2
      ) {
        // The user turned the map: keep following, their way up.
        onTwist?.();
      } else {
        const off = angleDelta(deg(heading), disp.heading);
        heading = rad(disp.heading - off * Math.exp(-dt / HEADING_UP_S));
      }
    }
    if (pitchGoal !== null) {
      pitch += (pitchGoal - pitch) * (1 - Math.exp(-dt / 0.35));
      if (Math.abs(pitchGoal - pitch) < rad(0.5)) pitchGoal = null;
    }
    hpr.heading = heading;
    hpr.pitch = Math.min(rad(-3), Math.max(rad(-89.9), pitch));
    hpr.range = range;
    aimPoint(range, hpr.pitch, target);
    camera.lookAt(target, hpr);
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    lastTarget = Cesium.Cartesian3.clone(target, lastTarget ?? new Cesium.Cartesian3());
    lastHeading = camera.heading;
  }

  // Back onto the marker after a pause: a short glide, keeping the zoom.
  function glideBack() {
    if (!fix || !disp.has || offCentre() < 0.05) return;
    const range = clampRange(Cesium.Cartesian3.distance(camera.positionWC, target));
    camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(Cesium.Cartesian3.clone(target), 0),
      {
        offset: new Cesium.HeadingPitchRange(camera.heading, camera.pitch, range),
        duration: 0.7,
      },
    );
    scene.requestRender();
  }

  // Added on demand, so it runs after the gestures' own preRender step.
  function startFrames() {
    removeFollowFrame ??= scene.preRender.addEventListener(followFrame);
  }
  function stopFrames() {
    removeFollowFrame?.();
    removeFollowFrame = null;
  }

  // A drag on the map pauses following; a pinch or a twist does not.
  const presses = new Map(); // pointerId -> { x, y, dragged }
  const onPress = (e) => {
    presses.set(e.pointerId, { x: e.clientX, y: e.clientY, dragged: false });
    if (fmode !== 'off') onTouch?.();
  };
  const onPointerMove = (e) => {
    const p = presses.get(e.pointerId);
    if (!p || p.dragged || presses.size !== 1 || fmode === 'off' || fpaused) return;
    // Left-button drag pans; the right (zoom), middle and modified (tilt) do not.
    if (
      e.pointerType === 'mouse' &&
      ((e.buttons & 1) === 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey)
    )
      return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_PX) return;
    p.dragged = true;
    onDrag?.();
  };
  const onRelease = (e) => presses.delete(e.pointerId);
  const canvas = scene.canvas;
  canvas.addEventListener('pointerdown', onPress, { passive: true });
  canvas.addEventListener('pointermove', onPointerMove, { passive: true });
  canvas.addEventListener('pointerup', onRelease, { passive: true });
  canvas.addEventListener('pointercancel', onRelease, { passive: true });

  // Something else took the camera (FOLLOW on a contact, the cockpit): yield.
  const removeTracked = viewer.trackedEntityChanged?.addEventListener((e) => {
    if (e && fmode !== 'off') onYield?.();
  });

  /** The follow state (core/geo/follow.js): { mode, paused }. */
  function setFollow(state) {
    const mode = state?.mode ?? 'off';
    const paused = Boolean(state?.paused);
    const was = fmode !== 'off' && !fpaused;
    const toHeading = mode === 'heading' && fmode !== 'heading';
    fmode = mode;
    fpaused = paused;
    if (fmode === 'off' || fpaused) {
      stopFrames();
      lastTarget = null;
      lastHeading = null;
      pitchGoal = null;
      return;
    }
    if (fmode !== 'heading') pitchGoal = null;
    else if (toHeading && camera.pitch < rad(-60)) pitchGoal = rad(HEADING_UP_PITCH);
    lastHeading = null; // our own turn is not a twist
    followT = 0;
    if (!was) {
      lastTarget = null;
      flightSeen = false;
      glideBack();
    }
    startFrames();
    scene.requestRender();
  }

  // ------------------------------------------------------------ public
  return {
    /** The latest state from the model: { fix (with heading) | null, live, locating }. */
    update(state) {
      if (destroyed) return;
      const next = state?.fix ?? null;
      const changed =
        next !== null &&
        (!fix ||
          next.lat !== fix.lat ||
          next.lon !== fix.lon ||
          next.t !== fix.t ||
          next.heading !== fix.heading ||
          next.speed !== fix.speed);
      if (changed) {
        const isNew =
          !fix || next.t !== fix.t || next.lat !== fix.lat || next.lon !== fix.lon;
        fix = { ...next };
        if (isNew) {
          rx = performance.now();
          sampleGround();
        }
        if (!disp.has || metresBetween(disp.lat, disp.lon, fix.lat, fix.lon) > SNAP_M) {
          disp.lat = fix.lat;
          disp.lon = fix.lon;
          disp.heading = Number.isFinite(fix.heading) ? fix.heading : disp.heading;
          disp.has = true;
        }
      } else if (!next && fix) {
        fix = null;
        disp.has = false;
      }
      if (Boolean(state?.locating) !== locating) {
        locating = Boolean(state?.locating);
        pulseT0 = performance.now();
      }
      live = Boolean(state?.live);
      if (fix) restyle();
      updateRing();
      // From rest, the first step is a short one (not the whole idle gap).
      if (!animating) lastStep = 0;
      animating = true;
      if (scene.primitives.get?.(scene.primitives.length - 1) !== coll)
        scene.primitives.raiseToTop?.(coll);
      claim(true);
      scene.requestRender();
    },

    setIcon(id) {
      meta = metaOf(id);
      imageKey = '';
      if (fix) restyle();
      scene.requestRender();
    },

    /** Follow-me: { mode: 'off'|'follow'|'heading', paused } (core/geo/follow.js). */
    setFollow,

    destroy() {
      setFollow(null);
      claim(false);
      destroyed = true;
      removePreRender();
      removeMoveEnd();
      removeTracked?.();
      canvas.removeEventListener('pointerdown', onPress);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onRelease);
      canvas.removeEventListener('pointercancel', onRelease);
      ringBatch.destroy();
      if (!coll.isDestroyed()) scene.primitives.remove(coll);
      scene.requestRender();
    },
  };
}
