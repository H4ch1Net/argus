import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tileOf,
  tileToLatLon,
  tilesAround,
  roadLines,
  createRoadTileLoader,
  TILES_FEED,
  TILESET_FEED,
} from './roadTiles.js';

// ------------------------------------------------------- a tiny MVT encoder
const varint = (n, out) => {
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
};
const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const bytesOf = (s) => [...new TextEncoder().encode(s)];
const lenDelim = (num, payload, out) => {
  varint(num * 8 + 2, out);
  varint(payload.length, out);
  out.push(...payload);
};
function encodeLines(name, feats) {
  const keys = [];
  const values = [];
  const layer = [];
  lenDelim(1, bytesOf(name), layer);
  for (const f of feats) {
    const tags = [];
    for (const [k, v] of Object.entries(f.props)) {
      if (!keys.includes(k)) keys.push(k);
      if (!values.includes(v)) values.push(v);
      tags.push(keys.indexOf(k), values.indexOf(v));
    }
    const cmds = [9, zz(f.pts[0]), zz(f.pts[1])];
    cmds.push(2 | ((f.pts.length / 2 - 1) << 3));
    for (let i = 2; i < f.pts.length; i += 2)
      cmds.push(zz(f.pts[i] - f.pts[i - 2]), zz(f.pts[i + 1] - f.pts[i - 1]));
    const feat = [];
    const packed = (num, arr) => {
      const p = [];
      for (const v of arr) varint(v, p);
      lenDelim(num, p, feat);
    };
    packed(2, tags);
    varint(3 * 8, feat);
    varint(2, feat); // a line
    packed(4, cmds);
    lenDelim(2, feat, layer);
  }
  for (const k of keys) lenDelim(3, bytesOf(k), layer);
  for (const v of values) {
    const val = [];
    lenDelim(1, bytesOf(v), val);
    lenDelim(4, val, layer);
  }
  varint(5 * 8, layer);
  varint(4096, layer);
  const out = [];
  lenDelim(3, layer, out);
  return new Uint8Array(out);
}

test('tiles: the one holding Indio, back to degrees, rings nearest first', () => {
  assert.deepEqual(tileOf(33.7206, -116.2156), { x: 2902, y: 6560 });
  const [lat, lon] = tileToLatLon(2902, 6560, 0, 0);
  assert.ok(lat > 33.7206 && lat - 33.7206 < 0.02);
  assert.ok(lon < -116.2156 && -116.2156 - lon < 0.03);
  const ring = tilesAround(2902, 6560, 1);
  assert.equal(ring.length, 9);
  assert.deepEqual(ring[0], { x: 2902, y: 6560, d: 0 });
  assert.equal(tilesAround(2902, 6560, 3).length, 49);
});

test('a tile -> named and numbered road lines in degrees', () => {
  const bytes = encodeLines('transportation_name', [
    {
      props: { name: 'Golf Center Parkway', class: 'secondary' },
      pts: [0, 0, 2048, 2048],
    },
    {
      props: { ref: 'CA 111 Old', network: 'road', class: 'primary' },
      pts: [0, 4096, 4096, 4096],
    },
    { props: { class: 'service' }, pts: [10, 10, 20, 20] }, // no name, no ref: skipped
  ]);
  const lines = roadLines(bytes, 2902, 6560);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].names, ['Golf Center Parkway']);
  assert.equal(lines[0].coords.length, 2);
  const mid = tileToLatLon(2902, 6560, 0.5, 0.5);
  assert.ok(Math.abs(lines[0].coords[1][0] - mid[0]) < 1e-6);
  assert.ok(Math.abs(lines[0].coords[1][1] - mid[1]) < 1e-6);
  assert.equal(lines[1].ref, 'CA 111 Old');
  assert.equal(lines[1].network, 'road');
});

test('the loader: tile set once, tiles kept, a failed tile asked again', async () => {
  const asked = [];
  let fail = true;
  const tile = encodeLines('transportation_name', [
    { props: { name: 'Jackson Street' }, pts: [100, 0, 100, 4096] },
  ]);
  const proxyClient = {
    getJson: async (feed, path) => {
      asked.push(`${feed}${path}`);
      return {
        tiles: [
          'https://tiles.openfreemap.org/planet/20261011_080001_pt/{z}/{x}/{y}.pbf',
        ],
      };
    },
    getBytes: async (feed, path) => {
      asked.push(`${feed}${path}`);
      if (path.endsWith('/2901/6559.pbf') && fail) throw new Error('busy');
      return tile;
    },
  };
  const load = createRoadTileLoader(proxyClient);
  const lines = await load({ lat: 33.7206, lon: -116.2156 }, 1);
  assert.equal(lines.length, 8); // 9 tiles, one failed
  assert.equal(asked.filter((a) => a === `${TILESET_FEED}/planet`).length, 1);
  assert.ok(asked.includes(`${TILES_FEED}/planet/20261011_080001_pt/14/2902/6560.pbf`));
  const before = asked.length;
  fail = false;
  const again = await load({ lat: 33.7206, lon: -116.2156 }, 1);
  assert.equal(again.length, 9);
  assert.equal(asked.length, before + 1); // only the failed tile again
  assert.equal(createRoadTileLoader({ getJson: async () => ({}) }), null); // no bytes
  const none = createRoadTileLoader({
    getJson: async () => ({ tiles: ['https://x/other/{z}/{x}/{y}.pbf'] }),
    getBytes: async () => tile,
  });
  await assert.rejects(none({ lat: 0, lon: 0 }, 1), /road tiles unavailable/);
});
