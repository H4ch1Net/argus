// Two-finger touch gestures: the recognizer, its jitter filter, a gentle
// inertia, the accidental-touch rules, and the camera pose math the gestures
// move the camera with. Pure: no DOM, no Cesium (unit-tested in node; the
// camera driver is core/interaction/cameraInput.js).
//
// A two-finger gesture starts undecided and only moves the map once it is
// clearly one of these ("resistance", like a map app):
//
// - pinch: the finger spacing changed by 6 % of where it started (at least
//   12 px). The map then scales with the spacing from that point on.
// - twist: the line between the fingers turned 14 degrees (22 once a pinch is
//   under way). The map then turns 1:1 with the fingers from that point, so it
//   never jumps by the dead zone. Angles are unwrapped (no 359 -> 0 jump).
// - tilt: both fingers moved 20 px up or down, the same way, side by side,
//   with the spacing and the angle nearly unchanged. A tilt locks out pinch
//   and twist until the fingers lift; pinch and twist combine.
//
// Spacing, angle and midpoint go through a 1-euro filter (steady while the
// fingers rest, little lag while they move fast), and changes under a third
// of a pixel wait until they add up, so resting fingers never shake the map.

const DEG = Math.PI / 180;

export const TWO_FINGER = Object.freeze({
  zoomPx: 12, // a pinch engages past this change in spacing...
  zoomPct: 0.06, // ...or this fraction of the starting spacing, whichever is larger
  zoomPxRotating: 16, // the same once a twist is under way
  zoomPctRotating: 0.1,
  rotateDeg: 14, // a twist engages past this turn
  rotateDegZooming: 22, // ...or this once a pinch is under way
  rotateMinSpacingPx: 48, // fingers closer than this give no usable angle
  tiltPx: 20, // both fingers this far up or down, the same way...
  tiltMaxTwistDeg: 8, // ...turning less than this...
  tiltFingerLineDeg: 50, // ...side by side (their line within this of level)...
  tiltStraightness: 0.5, // ...and moving mostly vertically (|dx| <= this x |dy|)
  noisePx: 0.35, // smaller changes wait until they add up
  minCutoffHz: 4, // the 1-euro filter: smoothing at rest...
  beta: 0.04, // ...relaxed with speed (per px/s)
  dCutoffHz: 1,
  velocityWindowMs: 100, // the release speed is measured over this...
  releaseStillMs: 60, // ...and is zero if the fingers rested this long first
});

// ------------------------------------------------------------------ filters

function smoothing(cutoffHz, dtS) {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
}

/**
 * A 1-euro filter (Casiez et al.): a low-pass whose cutoff rises with speed.
 * Times in ms.
 */
export function createOneEuro({ minCutoffHz = 4, beta = 0.04, dCutoffHz = 1 } = {}) {
  let x = 0;
  let dx = 0;
  let last = 0;
  let primed = false;
  return {
    reset(v, t) {
      x = v;
      dx = 0;
      last = t;
      primed = true;
    },
    filter(v, t) {
      if (!primed) {
        this.reset(v, t);
        return v;
      }
      const dt = Math.max(0.001, (t - last) / 1000);
      last = t;
      dx += smoothing(dCutoffHz, dt) * ((v - x) / dt - dx);
      x += smoothing(minCutoffHz + beta * Math.abs(dx), dt) * (v - x);
      return x;
    },
    get value() {
      return x;
    },
  };
}

/** An angle difference brought into (-pi, pi]. */
export function wrapPi(a) {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

// --------------------------------------------------------------- recognizer

const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Feed it the two fingers once per frame: begin() when the second finger
 * lands, update() each frame, end() when either lifts. update() returns what
 * to do to the camera since the previous update: zoom (a factor on the scale,
 * above 1 = fingers apart), rotate (radians the fingers turned, clockwise on
 * screen positive), tilt (px the pair moved down), mid (the filtered midpoint)
 * and mode (what is engaged). settling: the filter has not caught up with
 * the fingers yet, so ask for another frame even if they rest.
 * @param {Partial<typeof TWO_FINGER>} [opts]
 */
export function createTwoFingerRecognizer(opts = {}) {
  const o = { ...TWO_FINGER, ...opts };
  const fSpacing = createOneEuro(o);
  const fArc = createOneEuro(o); // the angle, as arc length at the start radius
  const fx = createOneEuro(o);
  const fy = createOneEuro(o);
  let active = false;
  let start = null;
  let rawAngle = 0;
  let unwrapped = 0;
  let radius = 1;
  let mode = { zoom: false, rotate: false, tilt: false };
  let flags = { noRotate: false, noTilt: false };
  const applied = { s: 1, angle: 0, y: 0 };
  const total = { lnZoom: 0, rotate: 0 };
  let history = [];
  let lastMid = { x: 0, y: 0 };

  function tiltStarts(a, b, angle) {
    const dyA = a.y - start.a.y;
    const dyB = b.y - start.b.y;
    if (Math.sign(dyA) !== Math.sign(dyB) || dyA === 0) return false;
    const need = o.tiltPx * 0.75;
    if (Math.abs(dyA) < need || Math.abs(dyB) < need) return false;
    const dy = (dyA + dyB) / 2;
    const dx = (a.x - start.a.x + b.x - start.b.x) / 2;
    if (Math.abs(dy) < o.tiltPx || Math.abs(dx) > o.tiltStraightness * Math.abs(dy)) {
      return false;
    }
    if (Math.abs(angle - start.angle) > o.tiltMaxTwistDeg * DEG) return false;
    // Side by side: the finger line within tiltFingerLineDeg of level.
    const line = Math.abs(wrapPi(start.angle));
    return Math.min(line, Math.PI - line) <= o.tiltFingerLineDeg * DEG;
  }

  return {
    get active() {
      return active;
    },
    get mode() {
      return { ...mode };
    },
    /**
     * @param {{x:number,y:number}} a
     * @param {{x:number,y:number}} b
     * @param {number} t  ms
     * @param {{ noRotate?: boolean, noTilt?: boolean }} [limits]
     */
    begin(a, b, t, { noRotate = false, noTilt = false } = {}) {
      const s = dist(a, b);
      rawAngle = Math.atan2(b.y - a.y, b.x - a.x);
      unwrapped = rawAngle;
      radius = Math.max(o.rotateMinSpacingPx, s) / 2;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      fSpacing.reset(s, t);
      fArc.reset(unwrapped * radius, t);
      fx.reset(mid.x, t);
      fy.reset(mid.y, t);
      start = { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, s, angle: unwrapped };
      mode = { zoom: false, rotate: false, tilt: false };
      flags = { noRotate, noTilt };
      applied.s = s;
      applied.angle = unwrapped;
      applied.y = mid.y;
      total.lnZoom = 0;
      total.rotate = 0;
      history = [{ t, lnZoom: 0, rotate: 0 }];
      lastMid = mid;
      active = true;
    },

    update(a, b, t) {
      if (!active) {
        return { zoom: 1, rotate: 0, tilt: 0, mid: lastMid, mode, changed: false };
      }
      const sRaw = dist(a, b);
      const raw = Math.atan2(b.y - a.y, b.x - a.x);
      unwrapped += wrapPi(raw - rawAngle);
      rawAngle = raw;
      const s = fSpacing.filter(sRaw, t);
      const angle = fArc.filter(unwrapped * radius, t) / radius;
      const midRawX = (a.x + b.x) / 2;
      const midRawY = (a.y + b.y) / 2;
      const mid = { x: fx.filter(midRawX, t), y: fy.filter(midRawY, t) };
      lastMid = mid;

      // Decide what the fingers are doing.
      if (!mode.zoom && !mode.rotate && !mode.tilt && !flags.noTilt) {
        if (tiltStarts(a, b, angle)) {
          mode.tilt = true;
          applied.y = mid.y;
        }
      }
      if (!mode.tilt) {
        const zoomNeed = mode.rotate
          ? Math.max(o.zoomPxRotating, o.zoomPctRotating * start.s)
          : Math.max(o.zoomPx, o.zoomPct * start.s);
        if (!mode.zoom && Math.abs(s - start.s) >= zoomNeed) {
          mode.zoom = true;
          applied.s = s;
        }
        const turnNeed = (mode.zoom ? o.rotateDegZooming : o.rotateDeg) * DEG;
        if (
          !mode.rotate &&
          !flags.noRotate &&
          s >= o.rotateMinSpacingPx &&
          Math.abs(angle - start.angle) >= turnNeed
        ) {
          mode.rotate = true;
          applied.angle = angle;
        }
      }

      // What changed since the last frame, past the noise floor.
      let zoom = 1;
      let rotate = 0;
      let tilt = 0;
      if (mode.zoom && Math.abs(s - applied.s) >= o.noisePx && s > 0) {
        zoom = s / applied.s;
        applied.s = s;
      }
      if (mode.rotate) {
        if (s < o.rotateMinSpacingPx) {
          applied.angle = angle; // too close to tell: hold, and resume from here
        } else if ((Math.abs(angle - applied.angle) * s) / 2 >= o.noisePx) {
          rotate = angle - applied.angle;
          applied.angle = angle;
        }
      }
      if (mode.tilt && Math.abs(mid.y - applied.y) >= o.noisePx) {
        tilt = mid.y - applied.y;
        applied.y = mid.y;
      }
      const changed = zoom !== 1 || rotate !== 0 || tilt !== 0;
      if (changed) {
        total.lnZoom += Math.log(zoom);
        total.rotate += rotate;
        history.push({ t, lnZoom: total.lnZoom, rotate: total.rotate });
        while (history.length > 2 && t - history[0].t > o.velocityWindowMs * 3) {
          history.shift();
        }
      }
      const settling =
        Math.abs(sRaw - s) >= o.noisePx ||
        (Math.abs(unwrapped - angle) * s) / 2 >= o.noisePx ||
        Math.abs(midRawY - mid.y) >= o.noisePx;
      return { zoom, rotate, tilt, mid, mode: { ...mode }, changed, settling };
    },

    /**
     * The fingers lifted at t (ms): the pinch and twist speeds at release
     * (natural log of the scale per second, radians per second), zero if the
     * fingers rested before lifting or that part never engaged.
     */
    end(t) {
      if (!active) return { zoom: 0, rotate: 0 };
      active = false;
      const last = history[history.length - 1];
      if (!last || t - last.t > o.releaseStillMs) return { zoom: 0, rotate: 0 };
      let ref = last;
      for (let i = history.length - 1; i >= 0; i -= 1) {
        if (last.t - history[i].t > o.velocityWindowMs) break;
        ref = history[i];
      }
      const dt = (last.t - ref.t) / 1000;
      if (dt < 0.02) return { zoom: 0, rotate: 0 };
      return {
        zoom: mode.zoom ? (last.lnZoom - ref.lnZoom) / dt : 0,
        rotate: mode.rotate ? (last.rotate - ref.rotate) / dt : 0,
      };
    },

    cancel() {
      active = false;
    },
  };
}

// ------------------------------------------------------------------ inertia

/**
 * A short glide after a fling: the release speeds (from end()) decay with time
 * constant tauMs. Slow releases do not glide; fast ones are capped so a glide
 * adds at most about a third to the zoom and a dozen degrees to the turn.
 * step(dtMs) returns the zoom factor and the turn for that slice of time.
 */
export function createInertia(
  { zoom = 0, rotate = 0 } = {},
  { tauMs = 110, minZoom = 0.3, maxZoom = 2.5, minRotate = 0.35, maxRotate = 2 } = {},
) {
  const clampAbs = (v, lo, hi) =>
    Math.abs(v) < lo ? 0 : Math.sign(v) * Math.min(hi, Math.abs(v));
  let vz = clampAbs(zoom, minZoom, maxZoom);
  let vr = clampAbs(rotate, minRotate, maxRotate);
  return {
    get done() {
      return vz === 0 && vr === 0;
    },
    step(dtMs) {
      const dt = Math.max(0, dtMs);
      const k = Math.exp(-dt / tauMs);
      const slice = (tauMs / 1000) * (1 - k); // the integral of e^(-t/tau) over dt
      const out = { zoom: Math.exp(vz * slice), rotate: vr * slice };
      vz *= k;
      vr *= k;
      if (Math.abs(vz) < 0.03) vz = 0;
      if (Math.abs(vr) < 0.03) vr = 0;
      return out;
    },
  };
}

// ---------------------------------------------------------- accidental touch

/** Contacts at least this wide (CSS px, about 13 mm) are a palm, not a finger. */
export const PALM_PX = 80;

/** A palm or the side of a hand: Pointer Events report the contact size (0 or 1 when unknown). */
export function isPalmContact({ width = 0, height = 0 } = {}, limitPx = PALM_PX) {
  return Math.max(width || 0, height || 0) >= limitPx;
}

/** Android's back-gesture strips along the left and right edges. */
export const EDGE_PX = 24;

/** A press that lands in an edge strip (x in CSS px across a viewport this wide). */
export function inEdgeZone(x, viewportWidth, edgePx = EDGE_PX) {
  return x < edgePx || (viewportWidth > 0 && x > viewportWidth - edgePx);
}

/**
 * A second finger that lands while a one-finger pan is far along and still
 * moving is a stray touch (a thumb at the edge, a grip), not a pinch: it is
 * ignored and the pan carries on. A pan that came to rest first can turn into
 * a pinch.
 */
export function isLateSecondFinger(
  { travelPx, sinceMoveMs },
  { farPx = 48, stillMs = 150 } = {},
) {
  return travelPx > farPx && sinceMoveMs < stillMs;
}

/**
 * Which touches on the map count, and which two make the gesture. down(),
 * move() and up() take one pointer each (x, y on the canvas, viewportX and
 * viewportWidth for the edge strips, the contact width and height, t in ms)
 * and say:
 * - ignore: a palm, or a stray second finger during a pan. The caller hides
 *   the pointer from everything else for its whole life (the pan goes on).
 * - started / ended: the pair (the first two fingers down, never a third or
 *   a palm) began or finished. When one of the pair lifts and two others are
 *   still down, the pair is those two, as a new gesture (no jump).
 * pair: the two fingers ({ x, y, edge }), or null.
 */
export function createTouchTracker({ palmPx = PALM_PX, edgePx = EDGE_PX, late } = {}) {
  const touches = new Map(); // id -> { id, x, y, x0, y0, tMove, pan, edge, palm }
  const ignored = new Set();
  let pair = null; // [id, id]

  function choosePair() {
    const ids = [];
    for (const [id, f] of touches) {
      if (!f.palm) ids.push(id);
      if (ids.length === 2) return ids;
    }
    return null;
  }
  function repair() {
    pair = choosePair();
    return { ignore: false, ended: true, started: pair !== null };
  }

  return {
    get size() {
      return touches.size;
    },
    get pair() {
      return pair ? [touches.get(pair[0]), touches.get(pair[1])] : null;
    },
    has(id) {
      return touches.has(id) || ignored.has(id);
    },
    down({ id, x, y, viewportX = x, viewportWidth = 0, width, height, t }) {
      if (isPalmContact({ width, height }, palmPx)) {
        ignored.add(id);
        return { ignore: true };
      }
      const others = [...touches.values()];
      const first = others.length === 1 ? others[0] : null;
      if (
        first?.pan &&
        isLateSecondFinger(
          {
            travelPx: Math.hypot(first.x - first.x0, first.y - first.y0),
            sinceMoveMs: t - first.tMove,
          },
          late,
        )
      ) {
        ignored.add(id);
        return { ignore: true };
      }
      for (const f of others) f.pan = false;
      touches.set(id, {
        id,
        x,
        y,
        x0: x,
        y0: y,
        tMove: t,
        pan: others.length === 0,
        edge: inEdgeZone(viewportX, viewportWidth, edgePx),
        palm: false,
      });
      if (pair) return { ignore: false };
      pair = choosePair();
      return { ignore: false, started: pair !== null };
    },
    move({ id, x, y, width, height, t }) {
      if (ignored.has(id)) return { ignore: true };
      const f = touches.get(id);
      if (!f) return { ignore: false };
      if (x !== f.x || y !== f.y) {
        f.x = x;
        f.y = y;
        f.tMove = t;
      }
      // A contact that spreads into a palm (a hand rolling onto the screen)
      // leaves the gesture; the caller already let the press through.
      if (!f.palm && isPalmContact({ width, height }, palmPx)) {
        f.palm = true;
        if (pair?.includes(id)) return repair();
      }
      return { ignore: false, inPair: Boolean(pair?.includes(id)) };
    },
    up(id) {
      if (ignored.delete(id)) return { ignore: true };
      if (!touches.delete(id)) return { ignore: false };
      if (pair?.includes(id)) return repair();
      return { ignore: false };
    },
    /** Forget every touch (the page lost focus mid-gesture). */
    clear() {
      touches.clear();
      ignored.clear();
      pair = null;
    },
  };
}

// ------------------------------------------------------------- camera poses
// A pose is { position, direction, up } in world (Earth-fixed) metres, as
// plain {x, y, z}. The gestures move it rigidly about a pivot (the ground
// under the fingers), which keeps the pivot under the same pixel.

const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const len = (a) => Math.hypot(a.x, a.y, a.z);

/** v turned by angle (right-handed) about the unit axis (Rodrigues). */
export function rotateVector(v, axis, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = dot(axis, v);
  const kxv = cross(axis, v);
  return {
    x: v.x * c + kxv.x * s + axis.x * kv * (1 - c),
    y: v.y * c + kxv.y * s + axis.y * kv * (1 - c),
    z: v.z * c + kxv.z * s + axis.z * kv * (1 - c),
  };
}

/** The pose turned by angle about the unit axis through pivot. */
export function orbitPose({ position, direction, up }, pivot, axis, angle) {
  return {
    position: add(pivot, rotateVector(sub(position, pivot), axis, angle)),
    direction: rotateVector(direction, axis, angle),
    up: rotateVector(up, axis, angle),
  };
}

/** The pose moved along the line to pivot: k = 0.5 halves the distance. */
export function slidePose({ position, direction, up }, pivot, k) {
  return { position: add(pivot, scale(sub(position, pivot), k)), direction, up };
}

/** How far the view looks above (+) or below (-) the level plane of normal, radians. */
export function elevationOf(direction, normal) {
  const d = len(direction) || 1;
  return Math.asin(Math.max(-1, Math.min(1, dot(direction, normal) / d)));
}

/**
 * The level axis a tilt turns about: the camera's right (direction x up)
 * laid flat on the plane of normal. Turning by +a about it raises the view by
 * a. Null if the camera's right points straight up or down (a rolled camera).
 */
export function levelAxis(direction, up, normal) {
  const right = cross(direction, up);
  const flat = sub(right, scale(normal, dot(right, normal)));
  const l = len(flat);
  return l > 1e-9 ? scale(flat, 1 / l) : null;
}

/**
 * The shallowest a tilt may look at the ground point it turns about, radians
 * below level: nearly the horizon close to the ground (a street view), a
 * steady 30 degrees down from orbit, log-scaled in between.
 */
export function maxTiltElevation(
  heightM,
  { lowM = 5e3, highM = 5e6, lowDeg = -3, highDeg = -30 } = {},
) {
  const h = Math.max(1, heightM || 1);
  const k = Math.min(
    1,
    Math.max(
      0,
      (Math.log10(h) - Math.log10(lowM)) / (Math.log10(highM) - Math.log10(lowM)),
    ),
  );
  return (lowDeg + (highDeg - lowDeg) * k) * DEG;
}

/** Radians of tilt per px the fingers move: half a turn over the screen height. */
export function tiltPerPx(canvasHeightPx) {
  return Math.PI / Math.max(200, canvasHeightPx || 0);
}
