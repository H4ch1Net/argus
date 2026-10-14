import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseIntersection,
  segmentCross,
  polylineMeets,
  findCrossings,
  lookupIntersection,
  overpassIntersectionQuery,
  parseOverpassNodes,
  nameRegex,
  refRegex,
  crossingPlace,
} from './intersection.js';
import { parseRoute } from './roads.js';

// Real road lines around Indio, CA (OpenFreeMap z14 tiles, Oct 2026).
const { lines } = JSON.parse(
  fs.readFileSync(new URL('./fixtures/indio-roads.json', import.meta.url), 'utf8'),
);
const INDIO = { lat: 33.7206, lon: -116.2156 };

const metres = (a, b) =>
  Math.hypot(
    (a.lat - b.lat) * 111_320,
    (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180),
  );

test('intersection queries: every separator, and names that only contain "and"', () => {
  for (const q of [
    'Highway 111 and Golf Center pkway',
    'Highway 111 & Golf Center pkway',
    'Highway 111 at Golf Center pkway',
    'Highway 111 / Golf Center pkway',
    'Highway 111 @ Golf Center pkway',
    'Highway 111 x Golf Center pkway',
    'corner of Highway 111 and Golf Center pkway',
    'Highway 111&Golf Center pkway',
  ]) {
    const p = parseIntersection(q);
    assert.ok(p, q);
    assert.equal(p.a, 'Highway 111', q);
    assert.equal(p.b, 'Golf Center pkway', q);
    assert.equal(p.strong, true, q);
  }
  assert.deepEqual(parseIntersection('Jackson St & Indio Blvd, Indio'), {
    a: 'Jackson St',
    b: 'Indio Blvd',
    where: 'Indio',
    strong: true,
  });
  // Tried, but not as a clear intersection: one side is not a street.
  assert.equal(parseIntersection('Monroe and Avenue 44').strong, false);
  assert.equal(parseIntersection('Lord and Taylor').strong, false);
  assert.equal(parseIntersection('Bed Bath and Beyond').strong, false);
  // Not intersections at all.
  for (const q of ['46211 Jackson street', 'fresno', 'starbucks', '5 & 6', 'and more'])
    assert.equal(parseIntersection(q), null, q);
  // The first separator that leaves two sides wins.
  assert.equal(parseIntersection('Avenue X & Main St').a, 'Avenue X');
});

test('segment crossing and roads that meet at a node', () => {
  assert.deepEqual(segmentCross([0, 0], [10, 10], [0, 10], [10, 0]), [5, 5]);
  assert.equal(segmentCross([0, 0], [10, 0], [0, 5], [10, 5]), null); // parallel
  assert.equal(segmentCross([0, 0], [1, 1], [5, 0], [6, -1]), null); // apart
  // A side street that stops 20 m short of the road it joins (simplified tiles).
  const road = [
    [0, -500],
    [0, 500],
  ];
  const side = [
    [-400, 0],
    [-20, 0],
  ];
  const [p] = polylineMeets(side, road);
  assert.ok(Math.abs(p[0] + 10) < 1e-9 && Math.abs(p[1]) < 1e-9);
  assert.deepEqual(
    polylineMeets(
      [
        [-400, 0],
        [-60, 0],
      ],
      road,
    ),
    [],
  );
});

test("the owner's query: Highway 111 and Golf Center pkway, from Indio", () => {
  const [c, ...more] = findCrossings(lines, 'Highway 111', 'Golf Center pkway', INDIO);
  assert.equal(more.length, 0);
  assert.equal(c.a, 'Highway 111');
  assert.equal(c.b, 'Golf Center Parkway');
  // Where Golf Center Parkway ends at 46th Avenue / Indio Boulevard (OSM ref
  // "CA 111 Old"); Photon's bus stops "Hwy 111 at Golf Center Pkwy" are
  // within 40 m of it.
  assert.ok(metres(c, { lat: 33.7149, lon: -116.2103 }) < 30, `${c.lat}, ${c.lon}`);
  assert.ok(metres(c, { lat: 33.7151, lon: -116.2106 }) < 60);
  assert.ok(c.distM > 600 && c.distM < 1000);
});

test('more crossings near Indio (names, refs, no street word, word order)', () => {
  const one = (a, b) => findCrossings(lines, a, b, INDIO)[0];
  const js = one('Jackson St', 'Indio Blvd');
  assert.equal(`${js.a} & ${js.b}`, 'Jackson Street & Indio Boulevard');
  assert.ok(metres(js, { lat: 33.7206, lon: -116.2162 }) < 40);
  const ma = one('Monroe', 'Avenue 44');
  assert.equal(`${ma.a} & ${ma.b}`, 'Monroe Street & Avenue 44');
  assert.ok(metres(ma, { lat: 33.7296, lon: -116.2336 }) < 40);
  const hj = one('Hwy 111', 'Jackson Street');
  assert.ok(metres(hj, { lat: 33.7149, lon: -116.2163 }) < 40);
  // I-10 crosses Golf Center Parkway at the interchange; its business loop
  // (Indio Boulevard, "I 10 BUS") meets it too, but is not shown then.
  const ig = findCrossings(lines, 'I-10', 'Golf Center Pkwy', INDIO);
  assert.equal(ig.length, 1);
  assert.equal(ig[0].a, 'I-10');
  assert.ok(metres(ig[0], { lat: 33.726, lon: -116.2015 }) < 60);
  // The business loop asked for by name.
  const bus = one('I-10 Business', 'Golf Center Pkwy');
  assert.equal(bus.a, 'I-10 Business');
  // Roads that do not meet, and names that are not roads here.
  assert.deepEqual(findCrossings(lines, 'Jackson St', 'Monroe St', INDIO), []);
  assert.deepEqual(findCrossings(lines, 'Lord', 'Taylor', INDIO), []);
});

test('half typed, the crossing is already there', () => {
  const [c] = findCrossings(lines, 'Highway 111', 'Golf Center pk', INDIO);
  assert.ok(c && metres(c, { lat: 33.7149, lon: -116.2103 }) < 30);
  assert.deepEqual(
    findCrossings(lines, 'Highway 111', 'Golf Center pk', INDIO, { partial: false }),
    [],
  );
});

test('lookup: ring by ring, then Overpass for a clear intersection', async () => {
  const asked = [];
  const loadRoads = async (near, ring) => {
    asked.push(ring);
    // Ring 1 has none of the roads; ring 2 has them all.
    return ring < 2 ? [] : lines;
  };
  const p = parseIntersection('Highway 111 and Golf Center pkway');
  const found = await lookupIntersection(p, { near: INDIO, loadRoads });
  assert.deepEqual(asked, [1, 2]);
  assert.equal(found[0].source, 'tiles');

  // Tiles unreadable: Overpass, for a clear intersection only.
  const calls = [];
  const proxyClient = {
    getJson: async (feed, path, { params }) => {
      calls.push({ feed, path, ql: params.data });
      return {
        elements: [
          { type: 'node', id: 1, lat: 33.71491, lon: -116.2103 },
          { type: 'node', id: 2, lat: 33.71495, lon: -116.21035 }, // same junction
          { type: 'node', id: 3, lat: 33.69, lon: -116.18 },
        ],
      };
    },
  };
  const broken = async () => {
    throw new Error('offline');
  };
  const viaOverpass = await lookupIntersection(p, {
    near: INDIO,
    loadRoads: broken,
    proxyClient,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].feed, 'overpass');
  assert.equal(calls[0].path, '/interpreter');
  assert.equal(viaOverpass.length, 2);
  assert.equal(viaOverpass[0].source, 'overpass');
  assert.equal(viaOverpass[0].a, 'Highway 111');
  assert.equal(viaOverpass[0].b, 'Golf Center Parkway');
  // "Lord and Taylor" never reaches Overpass.
  const weak = await lookupIntersection(parseIntersection('Lord and Taylor'), {
    near: INDIO,
    loadRoads: broken,
    proxyClient,
  });
  assert.deepEqual(weak, []);
  assert.equal(calls.length, 1);
});

test('the Overpass question: ways by name or ref around the user, their shared nodes', () => {
  const ql = overpassIntersectionQuery('Highway 111', 'Golf Center pkway', INDIO);
  assert.match(ql, /^\[out:json\]\[timeout:20\];/);
  assert.match(ql, /way\(around:8000,33\.72060,-116\.21560\)\["highway"\]\["ref"~/);
  assert.match(ql, /node\(w\.a\)\(w\.b\);out 20;$/);
  const name = new RegExp(nameRegex('Golf Center pkway'), 'i');
  for (const n of ['Golf Center Parkway', 'Golf Center Pkwy', 'North Golf Center Pkwy'])
    assert.ok(name.test(n), n);
  assert.ok(!name.test('Golf Center Parkway Bridge'));
  const ref = new RegExp(refRegex(parseRoute('Highway 111')), 'i');
  for (const r of ['CA 111', 'CA-111', 'CA 111 Old', 'US 99;CA 111'])
    assert.ok(ref.test(r), r);
  assert.ok(!ref.test('CA 1111'));
  assert.ok(!new RegExp(refRegex(parseRoute('I-10')), 'i').test('CA 10'));
  const nodes = parseOverpassNodes({ elements: [] }, INDIO, 'a st', 'b st');
  assert.deepEqual(nodes, []);
});

test('a crossing as a search place', () => {
  const p = crossingPlace(
    { lat: 33.714912, lon: -116.210281, a: 'Highway 111', b: 'Golf Center Parkway' },
    'Indio, California',
  );
  assert.deepEqual(p, {
    id: 'x:33.71491,-116.21028',
    name: 'Highway 111 & Golf Center Parkway',
    detail: 'Indio, California',
    lat: 33.714912,
    lon: -116.210281,
    kind: 'intersection',
  });
});
