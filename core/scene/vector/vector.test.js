import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTile, decodeGeometry } from './mvt.js';
import {
  sourceFor,
  runs,
  placeLabels,
  drawLabels,
  drawBase,
  roadWidth,
  metresPerPixel,
  tileLat,
  WANT,
} from './render.js';
import { createTileEngine } from './tiles.js';
import { tileTemplate, BASEMAP_TILES_FEED } from './client.js';

// ------------------------------------------------------------ an MVT encoder
// Just enough of the format to build test tiles (the decoder must read them).
const varint = (n, out) => {
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
};
const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const field = (num, wire, out) => varint(num * 8 + wire, out);
const bytesOf = (s) => [...new TextEncoder().encode(s)];
const lenDelim = (num, payload, out) => {
  field(num, 2, out);
  varint(payload.length, out);
  out.push(...payload);
};
function geometry(type, parts) {
  const cmds = [];
  let cx = 0;
  let cy = 0;
  for (const p of parts) {
    cmds.push((1 & 7) | (1 << 3));
    cmds.push(zz(p[0] - cx), zz(p[1] - cy));
    [cx, cy] = [p[0], p[1]];
    const n = p.length / 2 - (type === 3 ? 2 : 1);
    if (n > 0) {
      cmds.push((2 & 7) | (n << 3));
      for (let i = 2; i < 2 + n * 2; i += 2) {
        cmds.push(zz(p[i] - cx), zz(p[i + 1] - cy));
        [cx, cy] = [p[i], p[i + 1]];
      }
    }
    if (type === 3) cmds.push(7 | (1 << 3));
  }
  return cmds;
}
function encodeTile(layers) {
  const out = [];
  for (const [name, feats] of Object.entries(layers)) {
    const keys = [];
    const values = [];
    const layer = [];
    lenDelim(1, bytesOf(name), layer);
    for (const f of feats) {
      const tags = [];
      for (const [k, v] of Object.entries(f.props ?? {})) {
        if (!keys.includes(k)) keys.push(k);
        if (!values.some((x) => x === v)) values.push(v);
        tags.push(keys.indexOf(k), values.indexOf(v));
      }
      const feat = [];
      const packed = (num, arr) => {
        const p = [];
        for (const v of arr) varint(v, p);
        lenDelim(num, p, feat);
      };
      packed(2, tags);
      field(3, 0, feat);
      varint(f.type, feat);
      packed(4, geometry(f.type, f.parts));
      lenDelim(2, feat, layer);
    }
    for (const k of keys) lenDelim(3, bytesOf(k), layer);
    for (const v of values) {
      const val = [];
      if (typeof v === 'string') lenDelim(1, bytesOf(v), val);
      else if (Number.isInteger(v) && v >= 0) {
        field(5, 0, val);
        varint(v, val);
      } else if (typeof v === 'boolean') {
        field(7, 0, val);
        varint(v ? 1 : 0, val);
      } else {
        field(6, 0, val);
        varint(zz(v), val);
      }
      lenDelim(4, val, layer);
    }
    field(5, 0, layer);
    varint(4096, layer);
    field(15, 0, layer);
    varint(2, layer);
    lenDelim(3, layer, out);
  }
  return new Uint8Array(out);
}

const TILE = encodeTile({
  transportation: [
    { type: 2, props: { class: 'primary' }, parts: [[0, 2048, 4096, 2048]] },
    {
      type: 2,
      props: { class: 'minor', brunnel: 'bridge' },
      parts: [[2048, 0, 2048, 4096]],
    },
  ],
  transportation_name: [
    {
      type: 2,
      props: { class: 'primary', name: 'Avenue 51', ref: 'CA-111' },
      parts: [[0, 2048, 4096, 2048]],
    },
    {
      type: 2,
      props: { class: 'minor', name: 'Frederick Street' },
      parts: [[2048, 0, 2048, 4096]],
    },
  ],
  building: [
    {
      type: 3,
      props: { render_height: 5 },
      parts: [
        [100, 100, 300, 100, 300, 300, 100, 300],
        [3000, 3000, 3200, 3000, 3200, 3200, 3000, 3200],
      ],
    },
  ],
  place: [
    { type: 1, props: { class: 'city', name: 'Indio', rank: 3 }, parts: [[2000, 2000]] },
    {
      type: 1,
      props: { class: 'suburb', name: 'Overlap', rank: 9 },
      parts: [[2010, 2005]],
    },
  ],
  housenumber: [{ type: 1, props: { housenumber: '46211' }, parts: [[1000, 1000]] }],
  poi: [{ type: 1, props: { name: 'Skip me' }, parts: [[5, 5]] }],
});

test('decode: layers, typed values, geometry deltas, the want filter', () => {
  const t = decodeTile(TILE);
  assert.deepEqual(Object.keys(t).sort(), [
    'building',
    'housenumber',
    'place',
    'poi',
    'transportation',
    'transportation_name',
  ]);
  assert.equal(t.transportation.extent, 4096);
  const road = t.transportation.features[0];
  assert.equal(road.type, 2);
  assert.deepEqual(road.parts, [[0, 2048, 4096, 2048]]);
  assert.deepEqual(road.bbox, [0, 2048, 4096, 2048]);
  const b = t.building.features[0];
  assert.equal(b.parts.length, 2);
  assert.deepEqual(b.parts[0].slice(0, 2), b.parts[0].slice(-2), 'rings close');
  assert.equal(t.place.features[0].props.rank, 3);
  const only = decodeTile(TILE, { place: ['name'] });
  assert.deepEqual(Object.keys(only), ['place']);
  assert.deepEqual(only.place.features[0].props, { name: 'Indio' });
  // MoveTo(+3,+4) LineTo(-1,0): zigzag 6, 8, then 1, 0.
  assert.deepEqual(decodeGeometry([9, 6, 8, 10, 1, 0]).parts, [[3, 4, 2, 4]]);
});

test('deep zooms read a part of their zoom-14 ancestor', () => {
  assert.deepEqual(sourceFor(12, 5, 6), { z: 12, x: 5, y: 6, scale: 1, ox: 0, oy: 0 });
  assert.deepEqual(sourceFor(16, 4 * 100 + 3, 4 * 200 + 1), {
    z: 14,
    x: 100,
    y: 200,
    scale: 4,
    ox: 3,
    oy: 1,
  });
  assert.ok(Math.abs(tileLat(0, 0)) < 1e-9);
  // Real-width roads, never thinner than their floor.
  const lat = 33.7;
  assert.ok(roadWidth('minor', 18, lat, 2) > roadWidth('minor', 15, lat, 2));
  assert.equal(roadWidth('minor', 5, lat, 2), 0.8 * 2);
  assert.ok(metresPerPixel(18, 0) > 0.59 && metresPerPixel(18, 0) < 0.6);
});

test('straight runs of a line, longest first', () => {
  const r = runs([[0, 0, 100, 0, 200, 0, 200, 100]], 1);
  assert.equal(r.length, 2);
  assert.equal(r[0].len, 200);
  assert.equal(r[0].angle, 0);
  assert.ok(Math.abs(r[1].angle - Math.PI / 2) < 1e-9);
});

const measure = {
  measure: (text, font) => text.length * (parseInt(/(\d+)px/.exec(font)[1], 10) * 0.6),
};

test('labels: collisions resolved, upright text, road numbers, house numbers by zoom', () => {
  const t = decodeTile(TILE, WANT);
  const places = placeLabels(t, 'places', 12, 512, 2, measure);
  const names = places.filter((c) => c.text).map((c) => c.text);
  assert.deepEqual(names, ['INDIO'], 'the overlapping suburb gives way to the city');
  const roads16 = placeLabels(t, 'roads', 16, 512, 2, measure);
  const texts = roads16.map((c) => c.text);
  assert.ok(texts.includes('AVENUE 51'));
  assert.ok(texts.includes('FREDERICK STREET'));
  for (const c of roads16) {
    if (c.angle !== undefined)
      assert.ok(Math.abs(c.angle) <= Math.PI / 2 + 1e-9, 'upright');
  }
  assert.ok(!texts.includes('46211'), 'house numbers only from zoom 18');
  assert.ok(placeLabels(t, 'roads', 18, 512, 2, measure).some((c) => c.text === '46211'));
  assert.ok(placeLabels(t, 'roads', 13, 512, 2, measure).some((c) => c.shield));
  assert.ok(!texts.includes('SKIP ME'), 'points of interest only close up');
});

/** A canvas context that records what is drawn. */
function recorder() {
  const calls = [];
  const ctx = new Proxy(
    { measureText: (t) => ({ width: t.length * 7 }) },
    {
      get(target, k) {
        if (k in target) return target[k];
        return (...a) => calls.push([k, ...a]);
      },
      set(target, k, v) {
        target[k] = v;
        return true;
      },
    },
  );
  return { ctx, calls };
}

test('a label crossing two output tiles is drawn in both, at matching positions', () => {
  const t = decodeTile(TILE, WANT);
  const placed = placeLabels(t, 'places', 15, 512, 2, measure);
  // Zoom 15: the zoom-14 tile splits in 2 x 2; the city sits near its middle.
  const drawn = [];
  for (const [ox, oy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ]) {
    const { ctx, calls } = recorder();
    drawLabels(ctx, placed, { z: 15, x: 2 * 7 + ox, y: 2 * 9 + oy, size: 512, pr: 2 });
    const fill = calls.find((c) => c[0] === 'fillText' && c[1] === 'INDIO');
    const tr = calls.filter((c) => c[0] === 'translate').at(-1);
    if (fill) drawn.push([ox, oy, tr[1] + ox * 512, tr[2] + oy * 512]);
  }
  assert.ok(drawn.length >= 2, 'drawn in every tile it touches');
  const [first] = drawn;
  for (const d of drawn) {
    assert.ok(Math.abs(d[2] - first[2]) < 1e-6 && Math.abs(d[3] - first[3]) < 1e-6);
  }
});

test('base drawing paints ground, buildings close up, roads, bridges over roads', () => {
  const t = decodeTile(TILE, WANT);
  const { ctx, calls } = recorder();
  // Zoom 15, the lower right quarter: both roads at its edges, a building inside.
  drawBase(ctx, t, { z: 15, x: 2 * 7 + 1, y: 2 * 9 + 1, size: 512, pr: 2 });
  assert.equal(calls[0][0], 'fillRect');
  assert.ok(calls.filter((c) => c[0] === 'stroke').length >= 3);
  assert.ok(calls.some((c) => c[0] === 'fill'));
});

test('the tile engine fetches each source tile once and draws every kind', async () => {
  let fetches = 0;
  const engine = createTileEngine({
    template: 'https://proxy.test/feed/openfreemap-tiles/planet/v/{z}/{x}/{y}.pbf',
    fetchImpl: async (url) => {
      fetches += 1;
      assert.match(url, /\/14\/7\/9\.pbf$/);
      return { ok: true, status: 200, arrayBuffer: async () => TILE.buffer.slice(0) };
    },
    makeCanvas: () => ({ getContext: () => recorder().ctx }),
  });
  const kids = [
    [28, 36],
    [29, 36],
    [28, 37],
    [29, 37],
  ];
  await Promise.all(kids.map(([x, y]) => engine.render('base', 16, x, y, 512, 2)));
  assert.equal(fetches, 1, 'four zoom-16 tiles share one zoom-14 fetch');
  assert.ok(await engine.render('roads', 16, 28, 36, 512, 2));
  assert.equal(await engine.render('places', 8, 0, 0, 512, 2).catch(() => 'err'), 'err');
  assert.equal(engine.stats().decoded, 1);
});

test('the TileJSON tile URL becomes a pinned proxy URL', () => {
  const client = { buildUrl: (feed, path) => `https://p.test/feed/${feed}${path}` };
  assert.equal(
    tileTemplate(client, {
      tiles: ['https://tiles.openfreemap.org/planet/20261004_113936_pt/{z}/{x}/{y}.pbf'],
    }),
    `https://p.test/feed/${BASEMAP_TILES_FEED}/planet/20261004_113936_pt/{z}/{x}/{y}.pbf`,
  );
  assert.equal(
    tileTemplate(client, { tiles: ['https://evil.test/x/{z}/{x}/{y}.png'] }),
    null,
  );
  assert.equal(tileTemplate(client, {}), null);
});
