import * as Cesium from 'cesium';
import { createGroundBatch } from '../layers/surveillance/groundBatch.js';
import { acquireContinuousRender, releaseContinuousRender } from '../scene/renderMode.js';
import { INK } from '../ui/palette.js';
import { selfIconImage, selfPulseImage, SELF_ICONS } from '../ui/selfIcons.js';

// The user's own marker on the globe (core/geo/selfPosition.js feeds it): the
// chosen ctOS icon turned to the heading and drawn over everything, a subtle
// accuracy ring on the ground, the ctOS bracket pulse while locating, and
// follow-me (the camera rides with the marker).
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
const FOLLOW_MIN_RANGE_M = 250;
const FOLLOW_MAX_RANGE_M = 60_000;
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
 * @param {{ icon?: string, fps?: number, onFollow?: (on: boolean) => void }} [opts]
 */
export function createSelfMarker(
  viewer,
  { icon = SELF_ICONS[0].id, fps = 30, onFollow } = {},
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

  // Advance the display one step (idempotent within a frame: Cesium may ask
  // through the follow stand-in before preRender asks again).
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
  let standIn = null;
  const followPosition = new Cesium.CallbackProperty((time, result) => {
    advance();
    return Cesium.Cartesian3.fromDegrees(
      disp.lon,
      disp.lat,
      groundH,
      Cesium.Ellipsoid.WGS84,
      result,
    );
  }, false);

  function dropStandIn() {
    if (!standIn) return;
    const s = standIn;
    standIn = null;
    viewer.entities.remove(s);
    onFollow?.(false);
  }
  // Something else took the camera (FOLLOW on a contact, the cockpit): yield.
  const removeTracked = viewer.trackedEntityChanged?.addEventListener((e) => {
    if (standIn && e !== standIn) dropStandIn();
  });

  function follow(on) {
    if (!on) {
      if (standIn && viewer.trackedEntity === standIn) viewer.trackedEntity = undefined;
      dropStandIn();
      return false;
    }
    if (standIn) return true;
    if (!fix || !disp.has) return false;
    // Keep the view: the camera's offset from the marker, in its east-north-up
    // frame, clamped to a sensible range; straight down gets a slight tilt
    // along the current heading so the follow reads.
    const p = Cesium.Cartesian3.fromDegrees(disp.lon, disp.lat, groundH);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(p);
    const inv = Cesium.Matrix4.inverseTransformation(enu, new Cesium.Matrix4());
    const offset = Cesium.Matrix4.multiplyByPoint(
      inv,
      camera.positionWC,
      new Cesium.Cartesian3(),
    );
    const range = Cesium.Cartesian3.magnitude(offset);
    const clamped = Math.min(FOLLOW_MAX_RANGE_M, Math.max(FOLLOW_MIN_RANGE_M, range));
    if (range > 0) Cesium.Cartesian3.multiplyByScalar(offset, clamped / range, offset);
    if (offset.z > 0 && Math.hypot(offset.x, offset.y) < offset.z * 0.15) {
      const h = camera.heading;
      offset.x = -Math.sin(h) * offset.z * 0.6;
      offset.y = -Math.cos(h) * offset.z * 0.6;
    }
    standIn = viewer.entities.add({
      position: followPosition,
      point: { pixelSize: 1, color: Cesium.Color.TRANSPARENT },
      viewFrom: offset,
    });
    viewer.trackedEntity = standIn;
    scene.requestRender();
    onFollow?.(true);
    return true;
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

    /** Follow-me on or off; returns whether it is on. */
    follow,
    get following() {
      return Boolean(standIn);
    },

    destroy() {
      follow(false);
      claim(false);
      destroyed = true;
      removePreRender();
      removeMoveEnd();
      removeTracked?.();
      ringBatch.destroy();
      if (!coll.isDestroyed()) scene.primitives.remove(coll);
      scene.requestRender();
    },
  };
}
