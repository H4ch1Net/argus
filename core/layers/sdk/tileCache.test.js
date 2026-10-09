import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE_DEFAULTS,
  tileOptions,
  tileKey,
  tileBBox,
  tilesForView,
  tileCountForView,
  createTileStore,
  mergeTileRecords,
} from './tileCache.js';

test('options fill the defaults and snap the tile size to divide the globe', () => {
  const o = tileOptions({ tileDeg: 0.3, ttlMs: 1000 });
  assert.equal(o.ttlMs, 1000);
  assert.equal(o.maxTiles, TILE_DEFAULTS.maxTiles);
  assert.ok(Math.abs(180 / o.tileDeg - Math.round(180 / o.tileDeg)) < 1e-9);
  assert.equal(tileOptions({ tileDeg: 0.7 }).tileDeg, 180 / 257);
  assert.equal(tileOptions(true).tileDeg, TILE_DEFAULTS.tileDeg);
  // The cache always holds a whole view (or one view's tiles evict each other).
  const small = tileOptions({ maxTiles: 4, maxView: 20 });
  assert.ok(small.maxTiles > small.maxView);
});

test('a tile key and box', () => {
  assert.equal(tileKey(0.5, 10, 20), '0.5/10/20');
  assert.deepEqual(tileBBox(0.5, 361, 255), {
    lamin: 37.5,
    lamax: 38,
    lomin: 0.5,
    lomax: 1,
  });
  assert.deepEqual(tileBBox(2, 179, 89), {
    lamin: 88,
    lamax: 90,
    lomin: 178,
    lomax: 180,
  });
});

test('tiles cover a view, nearest the centre first', () => {
  const bbox = { lamin: 37.6, lamax: 37.9, lomin: -122.6, lomax: -122.2 };
  const tiles = tilesForView(bbox, 0.25);
  // lat 37.5-37.75, 37.75-38 ; lon -122.75..-122.5, -122.5..-122.25, -122.25..-122
  assert.equal(tiles.length, 6);
  assert.equal(tileCountForView(bbox, 0.25), 6);
  for (const t of tiles) {
    assert.ok(t.bbox.lamax > bbox.lamin && t.bbox.lamin < bbox.lamax);
    assert.ok(t.bbox.lomax > bbox.lomin && t.bbox.lomin < bbox.lomax);
  }
  for (let i = 1; i < tiles.length; i += 1) assert.ok(tiles[i].d >= tiles[i - 1].d);
  // The same view asks for the same keys: a pan inside a tile costs nothing.
  const again = tilesForView({ ...bbox, lomin: -122.55, lomax: -122.3 }, 0.25);
  assert.ok(again.every((t) => tiles.some((u) => u.key === t.key)));
});

test('a view ending on a tile edge does not take the next tile', () => {
  const tiles = tilesForView({ lamin: 10, lamax: 11, lomin: 20, lomax: 21 }, 1);
  assert.deepEqual(
    tiles.map((t) => t.key),
    ['1/200/100'],
  );
});

test('a view across the antimeridian is covered on both sides only', () => {
  const bbox = {
    lamin: -18.5,
    lamax: -17.5,
    lomin: -180,
    lomax: 180,
    wrap: { west: 179.2, east: -179.4 },
  };
  const tiles = tilesForView(bbox, 0.5);
  assert.equal(tileCountForView(bbox, 0.5), tiles.length);
  assert.ok(tiles.length <= 12, `${tiles.length} tiles`);
  assert.ok(tiles.every((t) => t.bbox.lomin >= 179 || t.bbox.lomax <= -179));
});

test('the count refuses a whole-globe view without listing it', () => {
  const whole = { lamin: -90, lamax: 90, lomin: -180, lomax: 180 };
  const t0 = performance.now();
  assert.equal(tileCountForView(whole, 0.25), 720 * 1440);
  assert.ok(performance.now() - t0 < 5);
});

test('the store expires by age, evicts the least recently used, and cools failures', () => {
  let t = 0;
  const s = createTileStore({ ttlMs: 100, maxTiles: 2, retryMs: 50, now: () => t });
  s.set('a', { list: [] });
  t = 10;
  s.set('b', { list: [] });
  assert.equal(s.isFresh('a'), true);
  s.touch('a'); // a is now the most recent
  s.set('c', { list: [] });
  assert.equal(s.has('b'), false);
  assert.equal(s.has('a'), true);
  t = 105;
  assert.equal(s.isFresh('a'), false); // stale, still served
  assert.equal(s.has('a'), true);
  assert.equal(s.isFresh('c'), true);
  s.fail('d');
  assert.equal(s.isCoolingDown('d'), true);
  t = 200;
  assert.equal(s.isCoolingDown('d'), false);
  s.fail('e');
  s.set('e', { list: [] });
  assert.equal(s.isCoolingDown('e'), false);
  // RELOAD: everything counts as expired but is still there to draw.
  s.fail('f');
  s.expireAll();
  assert.equal(s.isFresh('e'), false);
  assert.equal(s.has('e'), true);
  assert.equal(s.isCoolingDown('f'), false);
  s.clear();
  assert.equal(s.size, 0);
});

test('merging dedupes by id, keeps the first, and stops at the cap', () => {
  const a = { list: [{ id: 1 }, { id: 2 }] };
  const b = { list: [{ id: 2, from: 'b' }, { id: 3 }, null] };
  assert.deepEqual(
    mergeTileRecords([a, b]).map((n) => n.id),
    [1, 2, 3],
  );
  assert.equal(mergeTileRecords([a, b]).find((n) => n.id === 2).from, undefined);
  assert.equal(mergeTileRecords([a, b], 2).length, 2);
  assert.deepEqual(mergeTileRecords([null, {}]), []);
});
