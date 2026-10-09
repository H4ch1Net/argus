import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tileBBox,
  tilesCovering,
  viewSizeKm,
  bboxAround,
  bboxText,
  createTileStore,
  createLimiter,
  createTileLoader,
  createTiledSource,
  checkOverpass,
  mergeTiles,
  loadAround,
  tiledNote,
} from './tiles.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const node = (id, lat, lon) => ({ type: 'node', id, lat, lon, tags: {} });
const parse = (json) =>
  json.elements.map((e) => ({
    id: `node/${e.id}`,
    position: { latitude: e.lat, longitude: e.lon },
  }));

test('tiles: a fixed grid, keys like z/x/y, edges on a boundary stay out', () => {
  const b = tileBBox(0.1, 1823, 1287);
  assert.deepEqual(b, { lamin: 38.7, lamax: 38.8, lomin: 2.3, lomax: 2.4 });
  // A view exactly one tile: one tile, not its neighbours.
  const one = tilesCovering(b, 0.1);
  assert.equal(one.length, 1);
  assert.equal(one[0].key, '0.1/1823/1287');
  // A view across a corner: four tiles, centres inside them.
  const four = tilesCovering(
    { lamin: 38.75, lamax: 38.85, lomin: 2.35, lomax: 2.45 },
    0.1,
  );
  assert.equal(four.length, 4);
  for (const t of four) {
    assert.ok(t.lat > t.bbox.lamin && t.lat < t.bbox.lamax);
    assert.ok(t.lon > t.bbox.lomin && t.lon < t.bbox.lomax);
  }
  // Negative coordinates and the edges of the world.
  assert.equal(
    tilesCovering({ lamin: -33.9, lamax: -33.85, lomin: -70.7, lomax: -70.6 }, 0.1)
      .length,
    1,
  );
  assert.equal(
    tilesCovering({ lamin: -33.9, lamax: -33.85, lomin: -70.75, lomax: -70.6 }, 0.1)
      .length,
    2,
  );
  assert.ok(
    tilesCovering({ lamin: 89.95, lamax: 90, lomin: 179.95, lomax: 180 }, 0.1).length >=
      1,
  );
  assert.equal(bboxText(b), '38.7,2.3,38.8,2.4');
});

test('view size in km, and a box around a point', () => {
  const s = viewSizeKm({ lamin: 0, lamax: 0.1, lomin: 0, lomax: 0.1 });
  assert.ok(Math.abs(s.w - 11.13) < 0.05 && Math.abs(s.h - 11.06) < 0.05);
  assert.ok(Math.abs(s.across - Math.sqrt(s.w * s.h)) < 1e-9);
  const box = bboxAround({ lat: 60, lon: 10 }, 5);
  const v = viewSizeKm(box);
  assert.ok(Math.abs(v.w - 10) < 0.05 && Math.abs(v.h - 10) < 0.05);
});

test('the tile store keeps results for their time to live, newest last', () => {
  let t = 0;
  const st = createTileStore({ ttlMs: 100, maxTiles: 2, now: () => t });
  st.set('a', [1]);
  st.set('b', [2]);
  st.set('c', [3]); // evicts a
  assert.equal(st.get('a'), undefined);
  assert.deepEqual(st.get('b'), [2]);
  t = 101;
  assert.equal(st.get('b'), undefined, 'expired');
  assert.equal(st.size, 1);
});

test('the limiter runs at most n tasks at once, in order', async () => {
  const lim = createLimiter(2);
  let running = 0;
  let peak = 0;
  const order = [];
  const task = (i) => async () => {
    running += 1;
    peak = Math.max(peak, running);
    await tick();
    order.push(i);
    running -= 1;
    return i;
  };
  const out = await Promise.all([0, 1, 2, 3, 4].map((i) => lim.run(task(i))));
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('Overpass remarks are failures, never results', () => {
  assert.throws(
    () => checkOverpass({ elements: [], remark: 'runtime error: Query timed out' }),
    /Overpass/,
  );
  assert.throws(() => checkOverpass({ remark: 'x' }), /Overpass/);
  assert.throws(() => checkOverpass(null), /no elements/);
  const ok = { elements: [node(1, 0, 0)] };
  assert.equal(checkOverpass(ok), ok);
});

function fakeOverpass() {
  const asked = [];
  let fail = false;
  return {
    asked,
    fail: (v) => (fail = v),
    fetchTile: async (bbox) => {
      const id = asked.push(bboxText(bbox));
      await tick();
      if (fail) throw new Error('HTTP 504');
      return {
        elements: [
          node(id, (bbox.lamin + bbox.lamax) / 2, (bbox.lomin + bbox.lomax) / 2),
        ],
      };
    },
  };
}

test('a tile is fetched once: held tiles and in-flight requests are shared', async () => {
  const op = fakeOverpass();
  const loader = createTileLoader({
    fetchTile: op.fetchTile,
    parse,
    tileDeg: 0.1,
    ttlMs: 1e6,
    maxTiles: 9,
    limiter: createLimiter(2),
  });
  const [t] = tilesCovering(tileBBox(0.1, 10, 10), 0.1);
  loader.want([t]);
  const [a, b] = await Promise.all([loader.load(t), loader.load(t)]);
  assert.equal(op.asked.length, 1);
  assert.equal(a, b);
  assert.equal(await loader.load(t), a, 'held');
  assert.equal(op.asked.length, 1);
  loader.reload();
  await loader.load(t);
  assert.equal(op.asked.length, 2, 'RELOAD fetches again');
});

test('a failed tile is not kept and waits before it is asked again', async () => {
  let now = 0;
  const op = fakeOverpass();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const loader = createTileLoader({
      fetchTile: op.fetchTile,
      parse,
      tileDeg: 0.1,
      ttlMs: 1e6,
      maxTiles: 9,
      retryMs: 1000,
      now: () => now,
      limiter: createLimiter(2),
    });
    const [t] = tilesCovering(tileBBox(0.1, 3, 3), 0.1);
    loader.want([t]);
    op.fail(true);
    assert.equal(await loader.load(t), null);
    assert.ok(loader.isFailed(t.key));
    assert.equal(await loader.load(t), null, 'not retried yet');
    assert.equal(op.asked.length, 1);
    now = 1001;
    op.fail(false);
    assert.equal((await loader.load(t)).length, 1);
    assert.equal(op.asked.length, 2);
    assert.equal(loader.isFailed(t.key), false);
  } finally {
    console.warn = warn;
  }
});

test('a queued tile nobody wants any more is skipped', async () => {
  const op = fakeOverpass();
  const lim = createLimiter(1);
  const loader = createTileLoader({
    fetchTile: op.fetchTile,
    parse,
    tileDeg: 0.1,
    ttlMs: 1e6,
    maxTiles: 9,
    limiter: lim,
  });
  const tiles = tilesCovering(
    { lamin: 0.05, lamax: 0.25, lomin: 0.05, lomax: 0.15 },
    0.1,
  );
  loader.want(tiles);
  const p = tiles.map((t) => loader.load(t));
  loader.want(tiles.slice(0, 1)); // panned: only the first is still wanted
  const out = await Promise.all(p);
  assert.equal(op.asked.length, 1);
  assert.ok(out[0]);
  assert.ok(out.slice(1).every((x) => x === null));
});

test('the tiled source: too wide, partial, nearest the anchor first', async () => {
  const op = fakeOverpass();
  const loader = createTileLoader({
    fetchTile: op.fetchTile,
    parse,
    tileDeg: 0.1,
    ttlMs: 1e6,
    maxTiles: 50,
    limiter: createLimiter(4),
  });
  const src = createTiledSource(loader, {
    maxViewKm: 60,
    maxViewTiles: 4,
    anchor: () => ({ lat: 0.01, lon: 0.01 }),
  });
  const wide = await src({ bbox: { lamin: 0, lamax: 2, lomin: 0, lomax: 2 } });
  assert.equal(wide.tooWide, true);
  assert.equal(op.asked.length, 0);
  assert.equal(tiledNote(wide), 'zoom in to load');
  const part = await src({ bbox: { lamin: 0, lamax: 0.3, lomin: 0, lomax: 0.3 } });
  assert.equal(part.partial, true);
  assert.equal(part.tiles, 4);
  assert.equal(part.loaded, 4);
  assert.equal(part.items.length, 4);
  // The tile under the anchor came first.
  assert.equal(op.asked[0], '0,0,0.1,0.1');
  assert.equal(tiledNote(part), 'zoom in for all');
  // A second pass over the same view asks for nothing.
  await src({ bbox: { lamin: 0, lamax: 0.3, lomin: 0, lomax: 0.3 } });
  assert.equal(op.asked.length, 4);
});

test('progressive: the pass returns after the first tile, the rest call onUpdate once each landing settles, never looping', async () => {
  const op = fakeOverpass();
  let updates = 0;
  const loader = createTileLoader({
    fetchTile: op.fetchTile,
    parse,
    tileDeg: 0.1,
    ttlMs: 1e6,
    maxTiles: 50,
    limiter: createLimiter(1),
  });
  const src = createTiledSource(loader, {
    maxViewTiles: 9,
    onUpdate: () => (updates += 1),
    debounceMs: 5,
  });
  const view = { bbox: { lamin: 0, lamax: 0.2, lomin: 0, lomax: 0.2 } };
  const first = await src(view);
  assert.ok(first.loaded >= 1 && first.loaded < 4);
  assert.ok(first.pending > 0);
  assert.match(tiledNote(first), /^loading \d areas?/);
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(updates >= 1);
  const full = await src(view);
  assert.equal(full.loaded, 4);
  assert.equal(full.pending, 0);
  const before = updates;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(updates, before, 'a pass over held tiles does not call onUpdate');
});

test('an aborted pass rejects with AbortError and leaves the fetch to finish', async () => {
  const op = fakeOverpass();
  const loader = createTileLoader({
    fetchTile: op.fetchTile,
    parse,
    tileDeg: 0.1,
    ttlMs: 1e6,
    maxTiles: 50,
    limiter: createLimiter(1),
  });
  const src = createTiledSource(loader, {});
  const ac = new AbortController();
  const p = src({ bbox: { lamin: 0, lamax: 0.1, lomin: 0, lomax: 0.1 } }, ac.signal);
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(loader.cached('0.1/1800/900'), 'the tile still landed and is held');
});

test('loadAround waits for every tile around a point; merge keeps the first id', async () => {
  const op = fakeOverpass();
  const loader = createTileLoader({
    fetchTile: op.fetchTile,
    parse,
    tileDeg: 0.1,
    ttlMs: 1e6,
    maxTiles: 50,
    limiter: createLimiter(2),
  });
  const r = await loadAround(loader, { lat: 48.85, lon: 2.35 }, 3);
  assert.ok(r.items.length >= 1 && r.failed === 0);
  assert.deepEqual(
    mergeTiles([[{ id: 'a', v: 1 }], null, [{ id: 'a', v: 2 }, { id: 'b' }]]),
    [{ id: 'a', v: 1 }, { id: 'b' }],
  );
});
