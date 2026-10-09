import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surveillanceKindOf, SURVEILLANCE_KINDS, kindInfo } from './kinds.js';
import { parseSurveillance, normalizeSurveillance, surveillanceQuery } from './parse.js';
import {
  describeSurveillance,
  surveillanceSearchText,
  surveillanceKind,
} from './format.js';
import { nearestK, selectScope, scopeNote } from './select.js';
import { cameraCones } from './cones.js';
import { createSurveillanceSource } from './source.js';
import { ATLANTA_SF, PARIS_ENFORCEMENT } from './fixtures.js';
import { createSurveillanceMockSource } from './mockSource.js';

test('tags to kind: the OSM tagging of each device', () => {
  const k = (tags) => surveillanceKindOf(tags);
  assert.equal(k({ 'surveillance:type': 'ALPR' }), 'alpr');
  assert.equal(k({ 'surveillance:type': 'ANPR' }), 'alpr');
  assert.equal(k({ 'surveillance:type': 'license_plate_reader' }), 'alpr');
  // A toll gantry tagged as an ALPR reader is an ALPR reader.
  assert.equal(k({ highway: 'toll_gantry', 'surveillance:type': 'ALPR' }), 'alpr');
  assert.equal(k({ highway: 'toll_gantry', 'surveillance:type': 'camera' }), 'toll');
  assert.equal(k({ 'surveillance:type': 'gunshot_detector' }), 'acoustic');
  assert.equal(k({ 'surveillance:type': 'guard' }), 'guard');
  assert.equal(k({ highway: 'speed_camera' }), 'speed');
  assert.equal(k({ highway: 'speed_camera', enforcement: 'maxspeed' }), 'speed');
  assert.equal(
    k({ highway: 'speed_camera', enforcement: 'traffic_signals' }),
    'redlight',
  );
  assert.equal(
    k({ highway: 'speed_camera', speed_camera: 'traffic_signals' }),
    'redlight',
  );
  assert.equal(
    k({ highway: 'speed_camera', enforcement: 'maxspeed,traffic_signals' }),
    'redlight',
  );
  assert.equal(k({ highway: 'speed_camera', enforcement: 'average_speed' }), 'average');
  assert.equal(k({ 'camera:type': 'dome' }), 'dome');
  assert.equal(k({ 'camera:type': 'panorama' }), 'dome');
  assert.equal(k({ 'camera:type': 'panning' }), 'ptz');
  assert.equal(k({ 'camera:type': 'panorama_with_ptz' }), 'ptz');
  assert.equal(k({ 'camera:type': 'fixed' }), 'fixed');
  assert.equal(k({ 'surveillance:type': 'camera' }), 'fixed');
  assert.equal(k({}), 'fixed');
  // Every kind has a glyph, a size and an ink.
  for (const [id, v] of Object.entries(SURVEILLANCE_KINDS)) {
    assert.ok(v.glyph && v.px > 8 && v.ink && v.label, id);
  }
  assert.equal(kindInfo('nope'), SURVEILLANCE_KINDS.fixed);
});

test('the query asks for devices, speed cameras and enforcement relations per tile', () => {
  const ql = surveillanceQuery({ lamin: 48.8, lomin: 2.3, lamax: 48.9, lomax: 2.4 });
  assert.match(ql, /^\[out:json\]\[timeout:25\];/);
  assert.match(ql, /node\["man_made"="surveillance"\]\(48\.8,2\.3,48\.9,2\.4\);/);
  assert.match(ql, /way\["man_made"="surveillance"\]/);
  assert.match(ql, /node\["highway"="speed_camera"\]/);
  assert.match(
    ql,
    /rel\["type"="enforcement"\]\(48\.8,2\.3,48\.9,2\.4\)->\.r;node\(r\.r:"device"\);/,
  );
  assert.match(ql, /\.r out body \d+;$/);
});

test('real Atlanta / San Francisco elements parse into the right kinds', () => {
  const list = parseSurveillance(ATLANTA_SF);
  assert.equal(list.length, ATLANTA_SF.elements.length);
  const kinds = list.map((n) => n.meta.kind);
  assert.deepEqual(kinds.slice(0, 5), ['alpr', 'alpr', 'alpr', 'acoustic', 'acoustic']);
  assert.ok(kinds.includes('dome') && kinds.includes('ptz') && kinds.includes('guard'));
  assert.ok(kinds.includes('fixed'));
  for (const n of list) {
    assert.match(n.id, /^node\/\d+$/);
    assert.equal(n.type, 'surveillance');
    assert.ok(
      Number.isFinite(n.position.latitude) && Number.isFinite(n.position.longitude),
    );
  }
  // The ALPR card: maker, mount, facing, the DeFlock source and an OSM link.
  const flock = describeSurveillance(list[0]);
  assert.equal(flock.title, 'ALPR / plate reader');
  assert.equal(flock.subtitle, 'Flock Safety');
  const row = (card, label) => card.rows.find((r) => r[0] === label)?.[1];
  assert.equal(row(flock, 'Maker'), 'Flock Safety');
  assert.equal(row(flock, 'Mount'), 'traffic signals');
  assert.match(row(flock, 'Direction'), /^Faces 165 SSE, 60 deg view$/);
  assert.equal(row(flock, 'Source'), 'OpenStreetMap (DeFlock mapping)');
  assert.deepEqual(flock.links, [
    {
      label: 'OpenStreetMap',
      url: `https://www.openstreetmap.org/node/${list[0].meta.osmId}`,
    },
  ]);
  // A Raven gunshot detector: no facing, no cone.
  const raven = list.find((n) => n.meta.tags.name === 'Raven');
  const rc = describeSurveillance(raven);
  assert.equal(rc.title, 'Gunshot detector');
  assert.equal(row(rc, 'Direction'), undefined);
  assert.equal(cameraCones(raven), null);
  // A dome camera with no facing gets a ring.
  const dome = list.find((n) => n.meta.kind === 'dome');
  assert.equal(cameraCones(dome).ring, true);
  assert.match(surveillanceSearchText(list[0]), /ALPR reader.*Flock Safety/);
});

test('Paris: speed and red-light cameras through their enforcement relations', () => {
  const list = parseSurveillance(PARIS_ENFORCEMENT);
  const ids = list.map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length, 'devices sent twice come once');
  const by = Object.fromEntries(list.map((n) => [n.meta.osmId, n]));
  // A speed camera that is a relation's device carries the relation.
  const maub = by[414997089];
  assert.equal(maub.meta.kind, 'speed');
  assert.deepEqual(maub.meta.enforcement, {
    id: 151744,
    kind: 'maxspeed',
    name: 'Paris 9e - Rue de Maubeuge',
    maxspeed: '30',
  });
  const card = describeSurveillance(maub);
  const row = (label) => card.rows.find((r) => r[0] === label)?.[1];
  assert.equal(card.title, 'Speed camera');
  assert.equal(row('Enforces'), 'Speed limit');
  assert.equal(row('Limit'), '30 km/h');
  assert.equal(row('Section'), 'Paris 9e - Rue de Maubeuge');
  // A node tagged enforcement=traffic_signals is a red-light camera.
  assert.equal(by[7128024105].meta.kind, 'redlight');
  // A device whose node says enforcement=check but whose relation says
  // traffic_signals: the relation wins, and it is kept though untagged.
  assert.equal(by[2211556513].meta.kind, 'redlight');
  assert.equal(describeSurveillance(by[2211556513]).title, 'Red-light camera');
  // Enforcement cameras get a narrower, longer cone than CCTV.
  const cone = cameraCones({
    ...by[7128024105],
    meta: {
      ...by[7128024105].meta,
      tags: { ...by[7128024105].meta.tags, direction: '90' },
    },
  });
  assert.deepEqual(cone.cones, [{ headingDeg: 90, fovDeg: 30 }]);
  assert.equal(cone.rangeM, 90);
});

test('a relation device that is a plain road node of an unmapped rule is skipped', () => {
  const list = parseSurveillance({
    elements: [
      { type: 'node', id: 1, lat: 1, lon: 1, tags: {} },
      { type: 'node', id: 2, lat: 1, lon: 1.001, tags: {} },
      {
        type: 'relation',
        id: 9,
        members: [{ type: 'node', ref: 1, role: 'device' }],
        tags: { type: 'enforcement', enforcement: 'check' },
      },
      {
        type: 'relation',
        id: 10,
        members: [{ type: 'node', ref: 2, role: 'device' }],
        tags: { type: 'enforcement', enforcement: 'average_speed', maxspeed: '80' },
      },
    ],
  });
  assert.deepEqual(
    list.map((n) => [n.id, n.meta.kind]),
    [['node/2', 'average']],
  );
  assert.deepEqual(parseSurveillance(null), []);
  // A tiled pass hands its items straight through.
  const items = [{ id: 'x' }];
  assert.equal(normalizeSurveillance({ items }), items);
});

test('nearest n: a small sorted window over many records', () => {
  const at = { lat: 40, lon: -74 };
  const list = Array.from({ length: 500 }, (_, i) => ({
    id: i,
    position: {
      latitude: 40 + ((i * 37) % 101) / 1000 - 0.05,
      longitude: -74 + ((i * 53) % 97) / 1000 - 0.048,
    },
  }));
  const got = nearestK(list, at, 60);
  assert.equal(got.length, 60);
  const k = Math.cos((40 * Math.PI) / 180);
  const d = (n) =>
    ((n.position.longitude - at.lon) * k) ** 2 + (n.position.latitude - at.lat) ** 2;
  const brute = [...list].sort((a, b) => d(a) - d(b)).slice(0, 60);
  assert.deepEqual(
    got.map((n) => n.id),
    brute.map((n) => n.id),
  );
  for (let i = 1; i < got.length; i += 1) assert.ok(d(got[i - 1]) <= d(got[i]));
  assert.deepEqual(nearestK(list, null, 5), []);
  assert.equal(nearestK(list.slice(0, 3), at, 10).length, 3);
});

test('scope: nearest n to the anchor, or everything in view capped nearest first', () => {
  const pt = (id, lat, lon) => ({ id, position: { latitude: lat, longitude: lon } });
  const list = [pt('a', 0, 0), pt('b', 0, 0.01), pt('c', 0, 0.02), pt('d', 0, 0.5)];
  const view = { lamin: -0.1, lamax: 0.1, lomin: -0.1, lomax: 0.1 };
  const near = selectScope(list, {
    mode: 'nearest',
    anchor: { lat: 0, lon: 0.021 },
    view,
    nearest: 2,
  });
  assert.deepEqual(
    near.list.map((n) => n.id),
    ['c', 'b'],
  );
  assert.equal(scopeNote(near), 'nearest 2 of 4');
  // Without an anchor, the middle of the view.
  assert.deepEqual(
    selectScope(list, { mode: 'nearest', view, nearest: 1 }).list.map((n) => n.id),
    ['a'],
  );
  const all = selectScope(list, { mode: 'all', view });
  assert.deepEqual(
    all.list.map((n) => n.id),
    ['a', 'b', 'c'],
  );
  assert.equal(all.inView, 3);
  assert.equal(scopeNote(all), '');
  const capped = selectScope(list, {
    mode: 'all',
    view,
    anchor: { lat: 0, lon: 0.02 },
    max: 2,
  });
  assert.deepEqual(
    capped.list.map((n) => n.id),
    ['c', 'b'],
  );
  assert.equal(scopeNote(capped), 'nearest 2 of 3 in view');
  // No view and no anchor: everything, capped.
  assert.equal(selectScope(list, { max: 3 }).list.length, 3);
});

test('the source fetches one Overpass query per tile, once', async () => {
  const asked = [];
  const src = createSurveillanceSource({
    proxyClient: null,
    fetchTile: async (bbox) => {
      asked.push(bbox);
      return ATLANTA_SF;
    },
  });
  // Inside one 0.1 degree tile.
  const view = { bbox: { lamin: 33.75, lamax: 33.79, lomin: -84.39, lomax: -84.31 } };
  const a = await src(view);
  assert.equal(asked.length, 1);
  assert.ok(a.items.length > 0);
  const b = await src(view);
  assert.equal(asked.length, 1, 'held, not refetched');
  assert.equal(b.items.length, a.items.length);
  src.reload();
  await src(view);
  assert.equal(asked.length, 2);
  const wide = await src({ bbox: { lamin: 30, lamax: 36, lomin: -88, lomax: -80 } });
  assert.equal(wide.tooWide, true);
});

test('the dev mock shows every kind, one through a relation only', async () => {
  const viewer = {
    camera: {
      computeViewRectangle: () => ({ west: 0, south: 0, east: 0.01, north: 0.01 }),
    },
    scene: { globe: { ellipsoid: {} } },
  };
  const raw = await createSurveillanceMockSource({ viewer })();
  const kinds = new Set(parseSurveillance(raw).map((n) => surveillanceKind(n)));
  for (const k of [
    'alpr',
    'dome',
    'fixed',
    'ptz',
    'acoustic',
    'guard',
    'speed',
    'redlight',
    'average',
  ])
    assert.ok(kinds.has(k), k);
});
