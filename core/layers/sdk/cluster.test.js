import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLUSTER,
  createGridClusterer,
  clusterLabel,
  clusterSizePx,
  membersBox,
  createClusterPolicy,
  clusterPolicy,
  fanOffset,
  cellKey,
} from './cluster.js';

const R = 6_371_000;

test('contacts sharing a cell merge; a lone contact does not', () => {
  const g = createGridClusterer();
  g.begin(800, 600, 50, 0, 0);
  const a = g.add(110, 110, R, 0, 0);
  const b = g.add(140, 130, R, 0, 0);
  const c = g.add(400, 300, 0, R, 0);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(g.finish(2), 1);
  assert.equal(g.slotOf(a), 0);
  assert.equal(g.slotOf(c), -1);
  assert.equal(g.count(0), 2);
});

test('minPoints decides what merges', () => {
  const g = createGridClusterer();
  g.begin(800, 600, 50);
  const cells = [g.add(10, 10, R, 0, 0), g.add(12, 12, R, 0, 0), g.add(14, 14, R, 0, 0)];
  assert.equal(g.finish(4), 0);
  assert.equal(g.slotOf(cells[0]), -1);
  assert.equal(g.finish(3), 1);
  assert.equal(g.count(0), 3);
});

test('the grid offset moves the cell boundaries with the anchor', () => {
  const g = createGridClusterer();
  // Two points 10 px apart straddling x = 100 split at offset 0 ...
  g.begin(800, 600, 50, 0, 0);
  const a = g.add(95, 20, R, 0, 0);
  const b = g.add(105, 20, R, 0, 0);
  assert.notEqual(a, b);
  // ... and share a cell once the grid slides by 25 px (as during a pan).
  g.begin(800, 600, 50, 25, 0);
  assert.equal(g.add(95, 20, R, 0, 0), g.add(105, 20, R, 0, 0));
  // Offsets wrap: -25 is the same grid as 25.
  g.begin(800, 600, 50, -25, 0);
  assert.equal(g.add(95, 20, R, 0, 0), g.add(105, 20, R, 0, 0));
});

test('contacts past the margin never merge; those just off screen do', () => {
  const g = createGridClusterer();
  g.begin(400, 300, 50, 0, 0, 1);
  assert.equal(g.add(-500, 10, R, 0, 0), -1);
  assert.equal(g.add(10, 2000, R, 0, 0), -1);
  const a = g.add(-30, 10, R, 0, 0);
  const b = g.add(-20, 12, R, 0, 0);
  assert.ok(a >= 0);
  assert.equal(a, b);
  const r = g.add(430, 10, R, 0, 0);
  assert.ok(r >= 0);
});

test('the centroid sits at the members mean distance from the centre', () => {
  const g = createGridClusterer();
  g.begin(800, 600, 50);
  // Two surface points 90 degrees apart: their plain mean is inside the Earth.
  g.add(10, 10, R, 0, 0);
  g.add(11, 11, 0, R, 0);
  g.finish(2);
  const out = g.centroid(0, { x: 0, y: 0, z: 0 });
  assert.ok(Math.abs(Math.hypot(out.x, out.y, out.z) - R) < 1e-6);
  assert.ok(Math.abs(out.x - out.y) < 1e-6);
});

test('a pass resets the previous counts, and the arrays grow with the screen', () => {
  const g = createGridClusterer();
  g.begin(100, 100, 50);
  g.add(10, 10, R, 0, 0);
  g.add(12, 12, R, 0, 0);
  assert.equal(g.finish(2), 1);
  g.begin(100, 100, 50);
  g.add(10, 10, R, 0, 0);
  assert.equal(g.finish(2), 0);
  g.begin(4000, 3000, 20);
  assert.ok(g.cells > (4000 * 3000) / 400);
  const far = g.add(3990, 2990, R, 0, 0);
  assert.equal(far, g.add(3991, 2991, R, 0, 0));
  assert.equal(g.finish(2), 1);
});

test('10k contacts cluster in a few milliseconds', () => {
  const g = createGridClusterer();
  const t0 = performance.now();
  for (let pass = 0; pass < 5; pass += 1) {
    g.begin(1600, 900, CLUSTER.cellPx, pass * 7, pass * 3);
    for (let i = 0; i < 10_000; i += 1) g.add((i * 37) % 1700, (i * 91) % 1000, R, i, 0);
    g.finish(2);
  }
  const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 20, `one pass took ${ms.toFixed(2)} ms`);
});

test('labels are exact below 100, then coarse', () => {
  assert.equal(clusterLabel(2), '2');
  assert.equal(clusterLabel(99), '99');
  assert.equal(clusterLabel(120), '100+');
  assert.equal(clusterLabel(999), '900+');
  assert.equal(clusterLabel(1500), '1K+');
  assert.equal(clusterLabel(23_456), '23K+');
  assert.equal(clusterLabel(250_000), '99K+');
});

test('marker size steps with the count', () => {
  assert.ok(clusterSizePx(3) < clusterSizePx(30));
  assert.ok(clusterSizePx(30) < clusterSizePx(300));
  assert.ok(clusterSizePx(300) < clusterSizePx(3000));
});

test('members box: plain, and across the antimeridian', () => {
  assert.deepEqual(
    membersBox([
      { lon: 10, lat: 50 },
      { lon: 12, lat: 49 },
      { lon: 11, lat: 51 },
    ]),
    { west: 10, south: 49, east: 12, north: 51 },
  );
  const box = membersBox([
    { lon: 179, lat: -17 },
    { lon: -179, lat: -18 },
  ]);
  assert.equal(box.west, 179);
  assert.equal(box.east, -179);
  assert.equal(membersBox([]), null);
  assert.equal(membersBox([{ lon: NaN, lat: 1 }]), null);
});

test('the policy bumps its version and asks for a frame on a real change only', () => {
  let frames = 0;
  const p = createClusterPolicy(() => (frames += 1));
  assert.equal(p.active, true);
  assert.equal(p.set({ merge: true }), false);
  assert.equal(frames, 0);
  p.set({ hold: true });
  assert.equal(p.active, false);
  assert.equal(p.version, 1);
  const target = { id: 'x' };
  p.set({ pinned: target, hold: false });
  assert.equal(p.pinned, target);
  assert.equal(p.version, 2);
  p.set({ pinned: undefined });
  assert.equal(p.pinned, null);
  assert.equal(frames, 3);
  // Clearing an empty pin is no change.
  assert.equal(p.set({ pinned: undefined }), false);
  assert.equal(p.version, 3);
});

test('groups of different layers in one cell take slots in join order', () => {
  let frames = 0;
  const p = createClusterPolicy(() => (frames += 1));
  const a = p.join();
  const b = p.join();
  // b places first: alone in cell 7, so slot 0.
  assert.deepEqual(p.place(b, [7, 8]), [0, 0]);
  assert.equal(p.takePoke(b), false);
  // a (joined earlier) arrives in cell 7: it takes slot 0 and b is poked.
  assert.deepEqual(p.place(a, [7]), [0]);
  assert.equal(p.takePoke(b), true);
  assert.equal(p.takePoke(b), false); // taken
  assert.ok(frames > 0);
  // b regroups and now sits in slot 1 in cell 7, slot 0 in cell 8.
  assert.deepEqual(p.place(b, [7, 8]), [1, 0]);
  // Unchanged cells poke nobody.
  p.place(a, [7]);
  assert.equal(p.takePoke(b), false);
  // a leaves cell 7: b may move down, so it is poked.
  p.place(a, [9]);
  assert.equal(p.takePoke(b), true);
  assert.deepEqual(p.place(b, [7, 8]), [0, 0]);
  // a stops: its cells empty out; b is not in them, so no poke.
  p.leave(a);
  assert.equal(p.takePoke(b), false);
  assert.deepEqual(p.place(a, [7]), []); // a left: ignored
  assert.equal(p.anchor.ok, false);
});

test('fan offsets: slot 0 stays put, others spread', () => {
  assert.deepEqual(fanOffset(0), [0, 0]);
  assert.notDeepEqual(fanOffset(1), [0, 0]);
  assert.notDeepEqual(fanOffset(1), fanOffset(2));
  assert.deepEqual(fanOffset(-1), [0, 0]);
});

test('cell keys follow the anchor', () => {
  // A point and the anchor moving together keep their key (a pan).
  assert.equal(cellKey(130, 70, 100, 50, 50), cellKey(330, 270, 300, 250, 50));
  // Two points in different cells have different keys.
  assert.notEqual(cellKey(130, 70, 100, 50, 50), cellKey(160, 70, 100, 50, 50));
  // Points left of / above the anchor are fine.
  assert.notEqual(cellKey(40, 70, 100, 50, 50), cellKey(130, 70, 100, 50, 50));
});

test('a cell centre is inside its cell', () => {
  const g = createGridClusterer();
  g.begin(800, 600, 50, 13, 7);
  g.add(222, 333, R, 0, 0);
  g.add(224, 335, R, 0, 0);
  g.finish(2);
  const c = g.cellCenter(0, { x: 0, y: 0 });
  assert.ok(Math.abs(c.x - 222) < 25 && Math.abs(c.y - 333) < 25);
});

test('one policy per scene', () => {
  let renders = 0;
  const scene = { requestRender: () => (renders += 1) };
  assert.equal(clusterPolicy(scene), clusterPolicy(scene));
  assert.notEqual(clusterPolicy(scene), clusterPolicy({}));
  clusterPolicy(scene).set({ merge: false });
  assert.equal(renders, 1);
});
