import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  builtinBasemap,
  decodeTopologyArcs,
  loadNaturalEarth,
  graticuleStep,
  WORLD_ATLAS,
} from './basemap.js';

// A tiny quantized topology: one arc from (0,0) to (10,5) in lon/lat space.
const TOPO = {
  type: 'Topology',
  transform: { scale: [0.5, 0.25], translate: [-10, -5] },
  objects: { land: { type: 'GeometryCollection', geometries: [] } },
  arcs: [
    [
      [20, 20],
      [10, 0],
      [10, 20],
    ],
  ],
};

test('decodeTopologyArcs undoes delta + quantization', () => {
  const [line] = decodeTopologyArcs(TOPO);
  assert.deepEqual(line.points, [
    [0, 0],
    [5, 0],
    [10, 5],
  ]);
  assert.equal(line.minLat, 0);
  assert.equal(line.maxLat, 5);
  assert.throws(() => decodeTopologyArcs({ type: 'FeatureCollection' }));
});

test('the built-in outline covers every continent', () => {
  const bm = builtinBasemap();
  assert.ok(bm.lines.length > 30);
  const all = bm.lines.flatMap((l) => l.points);
  assert.ok(all.every(([lon, lat]) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90));
  // Spot checks: something near Cape Town, Tokyo, Rio, Sydney, Anchorage.
  const near = (lon, lat) =>
    all.some(([x, y]) => Math.abs(x - lon) < 3 && Math.abs(y - lat) < 3);
  for (const [lon, lat] of [
    [18.4, -33.9],
    [139.7, 35.7],
    [-43.2, -22.9],
    [151.2, -33.9],
    [-149.9, 61.2],
  ]) {
    assert.ok(near(lon, lat), `outline near ${lon},${lat}`);
  }
});

test('Natural Earth is fetched once through the proxy and then served from cache', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bm-'));
  const calls = [];
  const client = {
    getJson: async (feed, p) => {
      calls.push([feed, p]);
      return TOPO;
    },
  };
  const first = await loadNaturalEarth({ client, detail: '110m', dir });
  assert.equal(first.source, 'Natural Earth 110m');
  assert.deepEqual(calls, [['basemap', `/npm/${WORLD_ATLAS}/land-110m.json`]]);
  const second = await loadNaturalEarth({ client: null, detail: '110m', dir });
  assert.equal(second.lines.length, 1);
  assert.equal(calls.length, 1, 'served from the cache');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadNaturalEarth returns null when offline and uncached', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-bm-'));
  const client = {
    getJson: async () => {
      throw new Error('offline');
    },
  };
  assert.equal(await loadNaturalEarth({ client, detail: '50m', dir }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('graticule spacing adapts to the zoom', () => {
  assert.equal(graticuleStep(180), 30);
  assert.equal(graticuleStep(20), 5);
  assert.equal(graticuleStep(1), 0.25);
});
