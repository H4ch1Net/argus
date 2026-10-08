import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openRing,
  polygonParts,
  lineParts,
  ringCentroid,
  ringArea,
  capVertices,
  createRingMemo,
} from './rings.js';

const square = [
  [0, 0],
  [2, 0],
  [2, 2],
  [0, 2],
  [0, 0],
];

test('openRing drops the closing vertex and repeated points, rejects junk', () => {
  assert.deepEqual(openRing(square), [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ]);
  assert.equal(
    openRing([
      [0, 0],
      [1, 1],
      [0, 0],
    ]),
    null,
  );
  assert.equal(
    openRing([
      [0, 0],
      [1, 1],
      ['x', 2],
      [0, 0],
    ]),
    null,
  );
  assert.equal(
    openRing([
      [0, 0],
      [1, 91],
      [2, 2],
      [0, 0],
    ]),
    null,
  );
});

test('polygonParts reads Polygon and MultiPolygon with holes', () => {
  const hole = [
    [0.5, 0.5],
    [1, 0.5],
    [1, 1],
    [0.5, 0.5],
  ];
  const [p] = polygonParts({ type: 'Polygon', coordinates: [square, hole] });
  assert.equal(p.outer.length, 4);
  assert.equal(p.holes.length, 1);
  assert.equal(
    polygonParts({ type: 'MultiPolygon', coordinates: [[square], [square]] }).length,
    2,
  );
  assert.equal(polygonParts({ type: 'Point', coordinates: [0, 0] }), null);
  assert.equal(polygonParts({ type: 'Polygon', coordinates: [[[0, 0]]] }), null);
});

test('lineParts reads LineString and MultiLineString', () => {
  assert.deepEqual(
    lineParts({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
      ],
    }),
    [
      [
        [0, 0],
        [1, 1],
      ],
    ],
  );
  assert.equal(
    lineParts({
      type: 'MultiLineString',
      coordinates: [
        [
          [0, 0],
          [1, 1],
        ],
        [
          [2, 2],
          [3, 3],
        ],
      ],
    }).length,
    2,
  );
  assert.equal(
    lineParts({
      type: 'LineString',
      coordinates: [
        [0, 0],
        [200, 1],
      ],
    }),
    null,
  );
});

test('centroid and area survive the antimeridian', () => {
  const c = ringCentroid(openRing(square));
  assert.deepEqual([c.longitude, c.latitude], [1, 1]);
  const across = [
    [179, 10],
    [-179, 10],
    [-179, 12],
    [179, 12],
  ];
  const d = ringCentroid(across);
  assert.ok(Math.abs(Math.abs(d.longitude) - 180) < 1e-9, `got ${d.longitude}`);
  assert.equal(d.latitude, 11);
  assert.equal(ringArea(across), 4);
});

test('capVertices keeps at most max points', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => [i / 1000, 0]);
  assert.ok(capVertices(pts, 100).length <= 100);
  assert.equal(capVertices(pts, 2000), pts);
});

test('the ring memo keeps identity while coordinates are unchanged', () => {
  const memo = createRingMemo();
  const make = (lon) => [
    {
      id: 'a',
      meta: {
        polygon: [
          [lon, 0],
          [1, 0],
          [1, 1],
        ],
      },
    },
  ];
  const first = memo(make(0))[0].meta.polygon;
  const second = memo(make(0))[0].meta.polygon;
  assert.equal(first, second);
  const moved = memo(make(0.5))[0].meta.polygon;
  assert.notEqual(moved, first);
});
