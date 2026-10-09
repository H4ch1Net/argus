import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTwoFingerRecognizer,
  createInertia,
  createTouchTracker,
  createOneEuro,
  wrapPi,
  isPalmContact,
  inEdgeZone,
  isLateSecondFinger,
  rotateVector,
  orbitPose,
  slidePose,
  elevationOf,
  levelAxis,
  maxTiltElevation,
} from './twoFinger.js';

const DEG = Math.PI / 180;
const FRAME_MS = 16;

/** Two fingers on a circle about (cx, cy): spacing s, angle a (degrees, clockwise). */
function pairAt(cx, cy, s, aDeg) {
  const a = aDeg * DEG;
  const dx = (Math.cos(a) * s) / 2;
  const dy = (Math.sin(a) * s) / 2;
  return [
    { x: cx - dx, y: cy - dy },
    { x: cx + dx, y: cy + dy },
  ];
}

/**
 * Run a track (a list of [a, b] per frame, 16 ms apart; the first begins the
 * gesture) through a recognizer. Returns the per-frame outputs and the totals.
 */
function run(track, opts, limits) {
  const rec = createTwoFingerRecognizer(opts);
  const [a0, b0] = track[0];
  rec.begin(a0, b0, 0, limits);
  const outs = [];
  let zoom = 1;
  let rotate = 0;
  let tilt = 0;
  track.slice(1).forEach(([a, b], i) => {
    const o = rec.update(a, b, (i + 1) * FRAME_MS);
    outs.push(o);
    zoom *= o.zoom;
    rotate += o.rotate;
    tilt += o.tilt;
  });
  const t = track.length * FRAME_MS;
  return { rec, outs, zoom, rotate, tilt, mode: rec.mode, release: rec.end(t) };
}

/** n frames easing from p to q (linear), then hold frames at q. */
function ramp(from, to, n, hold = 20) {
  const out = [];
  for (let i = 0; i <= n; i += 1) out.push(from(i / n));
  for (let i = 0; i < hold; i += 1) out.push(to);
  return out;
}

/** A small seeded random source, so the noisy tracks repeat. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('a pure pinch zooms with the fingers and never rotates or tilts', () => {
  const track = ramp(
    (k) => pairAt(206, 450, 100 + 200 * k, 0),
    pairAt(206, 450, 300, 0),
    30,
  );
  const r = run(track);
  assert.equal(r.mode.zoom, true);
  assert.equal(r.mode.rotate, false);
  assert.equal(r.mode.tilt, false);
  assert.equal(r.rotate, 0);
  assert.equal(r.tilt, 0);
  // Scaled from where the pinch engaged (12 px in): about 300 / 112.
  assert.ok(r.zoom > 2.5 && r.zoom < 2.8, `zoom ${r.zoom}`);
  // Resting fingers settle: the last frames change nothing.
  assert.ok(r.outs.slice(-5).every((o) => !o.changed));
});

test('a pinch in zooms out by the inverse', () => {
  const track = ramp(
    (k) => pairAt(206, 450, 300 - 200 * k, 10),
    pairAt(206, 450, 100, 10),
    30,
  );
  const r = run(track);
  assert.ok(r.zoom < 0.4 && r.zoom > 0.3, `zoom ${r.zoom}`);
  assert.equal(r.rotate, 0);
});

test('a twist under the threshold does not rotate (resistance)', () => {
  const track = ramp((k) => pairAt(206, 450, 160, 10 * k), pairAt(206, 450, 160, 10), 20);
  const r = run(track);
  assert.equal(r.mode.rotate, false);
  assert.equal(r.rotate, 0);
  assert.equal(r.zoom, 1);
});

test('a twist past the threshold rotates 1:1 from there, without a jump', () => {
  const track = ramp((k) => pairAt(206, 450, 160, 60 * k), pairAt(206, 450, 160, 60), 40);
  const r = run(track);
  assert.equal(r.mode.rotate, true);
  assert.equal(r.mode.zoom, false);
  assert.equal(r.zoom, 1);
  // 60 degrees turned, the first 14 were the dead zone.
  assert.ok(Math.abs(r.rotate / DEG - 46) < 2, `rotate ${r.rotate / DEG}`);
  const steps = r.outs.map((o) => o.rotate).filter((x) => x !== 0);
  assert.ok(steps[0] / DEG < 2.5, `first step ${steps[0] / DEG} deg`);
  assert.ok(
    steps.every((x) => x > 0),
    'always the same way',
  );
  assert.ok(
    Math.max(...steps) / DEG < 3,
    'never more than the fingers turned in a frame',
  );
});

test('a counter-clockwise twist rotates the other way', () => {
  const track = ramp(
    (k) => pairAt(206, 450, 160, -40 * k),
    pairAt(206, 450, 160, -40),
    30,
  );
  const r = run(track);
  assert.ok(Math.abs(r.rotate / DEG + 26) < 2, `rotate ${r.rotate / DEG}`);
});

test('a parallel vertical drag tilts only', () => {
  const track = ramp(
    (k) => [
      { x: 150, y: 600 - 200 * k },
      { x: 262, y: 602 - 200 * k },
    ],
    [
      { x: 150, y: 400 },
      { x: 262, y: 402 },
    ],
    30,
  );
  const r = run(track);
  assert.equal(r.mode.tilt, true);
  assert.equal(r.mode.zoom, false);
  assert.equal(r.mode.rotate, false);
  assert.equal(r.rotate, 0);
  assert.equal(r.zoom, 1);
  // Up 200 px, the first ~20 were the dead zone.
  assert.ok(r.tilt < -170 && r.tilt > -195, `tilt ${r.tilt}`);
});

test('a tilt locks out a twist and a pinch that follow', () => {
  const up = ramp(
    (k) => pairAt(206, 600 - 120 * k, 120, 0),
    pairAt(206, 480, 120, 0),
    15,
    0,
  );
  const twist = ramp(
    (k) => pairAt(206, 480, 120 + 80 * k, 40 * k),
    pairAt(206, 480, 200, 40),
    20,
  );
  const r = run([...up, ...twist]);
  assert.equal(r.mode.tilt, true);
  assert.equal(r.rotate, 0);
  assert.equal(r.zoom, 1);
});

test('fingers one above the other moving together do not tilt', () => {
  const track = ramp(
    (k) => [
      { x: 200, y: 500 - 150 * k },
      { x: 210, y: 650 - 150 * k },
    ],
    [
      { x: 200, y: 350 },
      { x: 210, y: 500 },
    ],
    25,
  );
  const r = run(track);
  assert.equal(r.mode.tilt, false);
});

test('a noisy pinch zooms and never rotates', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const rnd = prng(seed);
    const jitter = () => (rnd() - 0.5) * 4; // +-2 px per finger per frame
    const track = ramp(
      (k) =>
        pairAt(206, 450, 120 + 200 * k, 4 * Math.sin(k * 6)).map((p) => ({
          x: p.x + jitter(),
          y: p.y + jitter(),
        })),
      pairAt(206, 450, 320, 0),
      40,
    );
    const r = run(track);
    assert.equal(r.mode.rotate, false, `seed ${seed}`);
    assert.equal(r.rotate, 0);
    assert.ok(r.zoom > 2.3 && r.zoom < 2.7, `seed ${seed} zoom ${r.zoom}`);
  }
});

test('resting fingers with sensor noise never move the camera', () => {
  const rnd = prng(9);
  const track = [];
  for (let i = 0; i < 120; i += 1) {
    track.push(
      pairAt(206, 450, 180, 30).map((p) => ({
        x: p.x + (rnd() - 0.5) * 2,
        y: p.y + (rnd() - 0.5) * 2,
      })),
    );
  }
  const r = run(track);
  assert.equal(r.zoom, 1);
  assert.equal(r.rotate, 0);
  assert.equal(r.tilt, 0);
});

test('the angle unwraps across 180 degrees: no full-turn jump', () => {
  // Starts with the second finger left of the first (atan2 near +180), then
  // turns 40 degrees clockwise through the wrap to -140.
  const track = ramp(
    (k) => pairAt(206, 450, 160, 175 + 40 * k),
    pairAt(206, 450, 160, 215),
    30,
  );
  const r = run(track);
  assert.ok(Math.abs(r.rotate / DEG - 26) < 2, `rotate ${r.rotate / DEG}`);
  assert.ok(r.outs.every((o) => Math.abs(o.rotate) < 5 * DEG));
  // And more than a whole turn adds up (less the dead zone, which a fast
  // twist overshoots by up to a frame's turn before it engages).
  const spin = ramp(
    (k) => pairAt(206, 450, 200, 400 * k),
    pairAt(206, 450, 200, 400),
    120,
  );
  const s = run(spin);
  assert.ok(s.rotate / DEG > 380 && s.rotate / DEG < 387, `spin ${s.rotate / DEG}`);
});

test('pinch and twist combine once both engaged', () => {
  const track = ramp(
    (k) => pairAt(206, 450, 120 + 200 * k, 50 * k),
    pairAt(206, 450, 320, 50),
    40,
  );
  const r = run(track);
  assert.equal(r.mode.zoom, true);
  assert.equal(r.mode.rotate, true);
  assert.ok(r.rotate > 20 * DEG && r.rotate < 36 * DEG, `rotate ${r.rotate / DEG}`);
  assert.ok(r.zoom > 2.2);
});

test('an edge-strip finger cannot rotate or tilt, only zoom', () => {
  const twist = ramp((k) => pairAt(206, 450, 160, 60 * k), pairAt(206, 450, 160, 60), 30);
  const r = run(twist, {}, { noRotate: true, noTilt: true });
  assert.equal(r.rotate, 0);
  const pinch = ramp(
    (k) => pairAt(206, 450, 100 + 100 * k, 0),
    pairAt(206, 450, 200, 0),
    20,
  );
  assert.ok(run(pinch, {}, { noRotate: true, noTilt: true }).zoom > 1.5);
});

test('fingers almost touching never rotate (their angle is noise)', () => {
  const track = ramp((k) => pairAt(206, 450, 30, 90 * k), pairAt(206, 450, 30, 90), 30);
  const r = run(track);
  assert.equal(r.rotate, 0);
});

test('release speed: a fling has one, fingers that rested first do not', () => {
  const fling = run(
    ramp((k) => pairAt(206, 450, 100 + 200 * k, 0), pairAt(206, 450, 300, 0), 12, 0),
  );
  assert.ok(fling.release.zoom > 1, `zoom speed ${fling.release.zoom}`);
  assert.equal(fling.release.rotate, 0); // never twisted
  const rested = run(
    ramp((k) => pairAt(206, 450, 100 + 200 * k, 0), pairAt(206, 450, 300, 0), 12, 30),
  );
  assert.equal(rested.release.zoom, 0);
});

test('inertia glides a little and stops; slow releases do not glide', () => {
  const g = createInertia({ zoom: 2, rotate: 1.5 });
  let zoom = 1;
  let rotate = 0;
  let steps = 0;
  while (!g.done && steps < 200) {
    const s = g.step(16);
    zoom *= s.zoom;
    rotate += s.rotate;
    steps += 1;
  }
  assert.ok(g.done);
  assert.ok(steps < 60, `${steps} frames`);
  assert.ok(zoom > 1.1 && zoom < 1.35, `glide zoom ${zoom}`);
  assert.ok(rotate > 0.1 && rotate < 0.2, `glide turn ${rotate}`);
  assert.ok(createInertia({ zoom: 0.1, rotate: 0.1 }).done);
  // Capped: a wild release still glides gently.
  const wild = createInertia({ zoom: 40 });
  let z = 1;
  while (!wild.done) z *= wild.step(16).zoom;
  assert.ok(z < 1.35, `capped glide ${z}`);
});

test('the touch tracker: a third finger never joins, the pair moves on without it', () => {
  const t = createTouchTracker();
  assert.equal(t.down({ id: 1, x: 100, y: 400, t: 0 }).started, false);
  assert.equal(t.down({ id: 2, x: 300, y: 400, t: 30 }).started, true);
  assert.deepEqual(
    t.pair.map((f) => f.id),
    [1, 2],
  );
  assert.equal(t.down({ id: 3, x: 200, y: 600, t: 300 }).started, undefined);
  assert.equal(t.move({ id: 3, x: 220, y: 620, t: 320 }).inPair, false);
  assert.deepEqual(
    t.pair.map((f) => f.id),
    [1, 2],
  );
  // One of the pair lifts: the two still down are a new gesture.
  const up = t.up(1);
  assert.equal(up.ended, true);
  assert.equal(up.started, true);
  assert.deepEqual(
    t.pair.map((f) => f.id),
    [2, 3],
  );
  const up2 = t.up(2);
  assert.equal(up2.ended, true);
  assert.equal(up2.started, false);
  assert.equal(t.pair, null);
});

test('the touch tracker: a palm is ignored for its whole life', () => {
  const t = createTouchTracker();
  t.down({ id: 1, x: 100, y: 400, width: 20, height: 22, t: 0 });
  assert.equal(
    t.down({ id: 2, x: 300, y: 700, width: 140, height: 90, t: 10 }).ignore,
    true,
  );
  assert.equal(t.pair, null);
  assert.equal(t.move({ id: 2, x: 310, y: 700, t: 20 }).ignore, true);
  assert.equal(t.up(2).ignore, true);
  // A finger that spreads into a palm leaves the gesture.
  t.down({ id: 3, x: 300, y: 400, width: 20, height: 20, t: 40 });
  assert.ok(t.pair);
  const grew = t.move({ id: 3, x: 300, y: 400, width: 120, height: 100, t: 60 });
  assert.equal(grew.ended, true);
  assert.equal(t.pair, null);
});

test('the touch tracker: a stray second finger during a pan is ignored', () => {
  const t = createTouchTracker();
  t.down({ id: 1, x: 100, y: 400, t: 0 });
  for (let i = 1; i <= 10; i += 1) t.move({ id: 1, x: 100 + i * 12, y: 400, t: i * 16 });
  assert.equal(t.down({ id: 2, x: 20, y: 500, t: 170 }).ignore, true);
  assert.equal(t.pair, null);
  // A pan that came to rest can become a pinch.
  const r = createTouchTracker();
  r.down({ id: 1, x: 100, y: 400, t: 0 });
  r.move({ id: 1, x: 200, y: 400, t: 100 });
  assert.equal(r.down({ id: 2, x: 300, y: 400, t: 600 }).started, true);
  // A finger left over from a pinch is no pan: a new second finger pairs.
  r.up(2);
  r.move({ id: 1, x: 260, y: 400, t: 640 });
  assert.equal(r.down({ id: 4, x: 100, y: 400, t: 650 }).started, true);
});

test('the touch tracker: edge strips mark the finger', () => {
  const t = createTouchTracker();
  t.down({ id: 1, x: 10, y: 400, viewportX: 10, viewportWidth: 412, t: 0 });
  t.down({ id: 2, x: 200, y: 400, viewportX: 200, viewportWidth: 412, t: 20 });
  assert.deepEqual(
    t.pair.map((f) => f.edge),
    [true, false],
  );
});

test('accidental-touch rules', () => {
  assert.equal(isPalmContact({ width: 24, height: 30 }), false);
  assert.equal(isPalmContact({ width: 1, height: 1 }), false); // unknown size
  assert.equal(isPalmContact({}), false);
  assert.equal(isPalmContact({ width: 90, height: 40 }), true);
  assert.equal(inEdgeZone(10, 412), true);
  assert.equal(inEdgeZone(400, 412), true);
  assert.equal(inEdgeZone(206, 412), false);
  assert.equal(isLateSecondFinger({ travelPx: 120, sinceMoveMs: 20 }), true);
  assert.equal(isLateSecondFinger({ travelPx: 120, sinceMoveMs: 400 }), false);
  assert.equal(isLateSecondFinger({ travelPx: 10, sinceMoveMs: 10 }), false);
});

test('wrapPi and the 1-euro filter', () => {
  assert.ok(Math.abs(wrapPi((3 * Math.PI) / 2) + Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(wrapPi((-3 * Math.PI) / 2) - Math.PI / 2) < 1e-12);
  assert.equal(wrapPi(0.5), 0.5);
  const f = createOneEuro();
  f.reset(100, 0);
  let v = 100;
  for (let i = 1; i <= 60; i += 1) v = f.filter(200, i * 16);
  assert.ok(Math.abs(v - 200) < 0.5, 'catches up with a step');
});

// ------------------------------------------------------------- pose math

const R = 6378137;
const unit = (v) => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const near = (a, b, eps) =>
  Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.z - b.z) < eps;

test('rotateVector turns right-handed about the axis', () => {
  const v = rotateVector({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, Math.PI / 2);
  assert.ok(near(v, { x: 0, y: 1, z: 0 }, 1e-12));
});

test('turning about the vertical keeps the pivot and turns the heading', () => {
  // A camera 1 km above a point on the equator at lon 0, looking straight down,
  // north up. Local frame there: east = +y, north = +z, up = +x.
  const pivot = { x: R, y: 0, z: 0 };
  const pose = {
    position: { x: R + 1000, y: 0, z: 0 },
    direction: { x: -1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  };
  const turned = orbitPose(pose, pivot, { x: 1, y: 0, z: 0 }, 30 * DEG);
  assert.ok(near(turned.position, pose.position, 1e-6)); // on the axis
  // Up (the screen's top) turned from north toward west: heading -30.
  assert.ok(
    turned.up.y < 0 && Math.abs(Math.atan2(-turned.up.y, turned.up.z) - 30 * DEG) < 1e-9,
  );
});

test('a tilt about the level axis raises the view by the angle and keeps the pivot ahead', () => {
  const pivot = { x: R, y: 0, z: 0 };
  const normal = { x: 1, y: 0, z: 0 };
  // 45 degrees down toward north, 1414 m from the pivot.
  const dir = unit({ x: -1, y: 0, z: 1 });
  const pose = {
    position: { x: R + 1000, y: 0, z: -1000 },
    direction: dir,
    up: unit({ x: 1, y: 0, z: 1 }),
  };
  assert.ok(Math.abs(elevationOf(dir, normal) + 45 * DEG) < 1e-9);
  const axis = levelAxis(pose.direction, pose.up, normal);
  const out = orbitPose(pose, pivot, axis, 20 * DEG);
  assert.ok(Math.abs(elevationOf(out.direction, normal) + 25 * DEG) < 1e-9);
  // Still looking straight at the pivot, from as far.
  const toPivot = unit({
    x: pivot.x - out.position.x,
    y: pivot.y - out.position.y,
    z: pivot.z - out.position.z,
  });
  assert.ok(near(toPivot, out.direction, 1e-9));
  const d = Math.hypot(out.position.x - R, out.position.y, out.position.z);
  assert.ok(Math.abs(d - Math.SQRT2 * 1000) < 1e-6);
});

test('a slide halves the distance and keeps the orientation', () => {
  const pose = {
    position: { x: R + 1000, y: 0, z: 0 },
    direction: { x: -1, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  };
  const out = slidePose(pose, { x: R, y: 0, z: 0 }, 0.5);
  assert.ok(near(out.position, { x: R + 500, y: 0, z: 0 }, 1e-6));
  assert.equal(out.direction, pose.direction);
});

test('the tilt limit is near the horizon low down and steeper from orbit', () => {
  assert.ok(Math.abs(maxTiltElevation(1000) + 3 * DEG) < 1e-12);
  assert.ok(Math.abs(maxTiltElevation(2e7) + 30 * DEG) < 1e-12);
  const mid = maxTiltElevation(150_000);
  assert.ok(mid < -3 * DEG && mid > -30 * DEG);
});
