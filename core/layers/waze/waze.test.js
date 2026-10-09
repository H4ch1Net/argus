import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWaze,
  wazeBox,
  wazeQuery,
  wazeLocalQuery,
  wazeEnv,
  wazeKind,
  wazeLabel,
} from './parse.js';
import { describeWaze, wazeGlyph, reportedAgo } from './format.js';
import { createWazeSource, createWazeMockSource } from './source.js';

const T = Date.UTC(2026, 9, 9, 12, 0, 0);

// The live map's georss shape (alerts with location {x, y}, jams with line),
// plus a users array the layer must never read.
const LIVE = {
  alerts: [
    {
      uuid: 'a1',
      type: 'ACCIDENT',
      subtype: 'ACCIDENT_MAJOR',
      location: { x: -122.41, y: 37.77 },
      street: 'Market St',
      city: 'San Francisco',
      reliability: 8,
      confidence: 3,
      nThumbsUp: 4,
      reportBy: 'someone',
      reportDescription: 'free text from a driver',
      pubMillis: T - 6 * 60_000,
    },
    {
      uuid: 'a2',
      type: 'POLICE',
      subtype: 'POLICE_VISIBLE',
      location: { x: -122.42, y: 37.78 },
    },
    { uuid: 'a3', type: 'CHIT_CHAT', location: { x: -122.4, y: 37.76 } },
    {
      uuid: 'a4',
      type: 'HAZARD',
      subtype: 'HAZARD_ON_ROAD_POT_HOLE',
      location: { x: -122.43, y: 37.75 },
    },
    {
      uuid: 'a5',
      type: 'WEATHERHAZARD',
      subtype: 'HAZARD_WEATHER_FOG',
      location: { x: -122.44, y: 37.74 },
    },
    {
      uuid: 'a6',
      type: 'ROAD_CLOSED',
      subtype: 'ROAD_CLOSED_CONSTRUCTION',
      location: { x: -122.45, y: 37.73 },
    },
    { uuid: 'bad', type: 'ACCIDENT', location: { x: 'nope', y: 99 } },
  ],
  jams: [
    {
      uuid: 'j1',
      level: 4,
      speedKMH: 9.4,
      delay: 240,
      length: 1200,
      street: 'US-101 N',
      city: 'San Francisco',
      line: [
        { x: -122.4, y: 37.77 },
        { x: -122.401, y: 37.771 },
        { x: -122.402, y: 37.772 },
      ],
      pubMillis: T - 60_000,
    },
    {
      uuid: 'j2',
      level: 5,
      delay: -1,
      line: [
        { x: -122.39, y: 37.76 },
        { x: -122.391, y: 37.761 },
      ],
    },
  ],
  users: [{ id: 'u1', location: { x: -122.4, y: 37.7 }, userName: 'wazer' }],
};

test('alerts and jams normalize; chatter, users and reporters never do', () => {
  const list = parseWaze(LIVE);
  const ids = list.map((n) => n.id);
  assert.deepEqual(ids, [
    'waze/a/a1',
    'waze/a/a2',
    'waze/a/a4',
    'waze/a/a5',
    'waze/a/a6',
    'waze/j/j1',
    'waze/j/j2',
  ]);
  const text = JSON.stringify(list);
  for (const banned of ['someone', 'free text', 'wazer', 'u1']) {
    assert.equal(text.includes(banned), false, banned);
  }
  const a1 = list[0];
  assert.deepEqual(a1.position, { longitude: -122.41, latitude: 37.77, altitude: 0 });
  assert.equal(a1.meta.kind, 'accident');
  assert.equal(a1.meta.severity, 'critical');
  assert.equal(a1.meta.label, 'Major accident');
  assert.equal(a1.meta.thumbs, 4);
  assert.deepEqual(
    list.slice(1, 5).map((n) => [n.meta.kind, n.meta.label]),
    [
      ['police', 'Police (visible)'],
      ['hazard', 'Pothole'],
      ['weather', 'Fog'],
      ['closure', 'Road closed (construction)'],
    ],
  );
  const [j1, j2] = list.slice(5);
  assert.equal(j1.type, 'waze-jam');
  assert.equal(j1.meta.speedKmh, 9);
  assert.equal(j1.meta.severity, 'notable');
  assert.deepEqual(j1.position, { longitude: -122.401, latitude: 37.771, altitude: 0 });
  assert.equal(j1.meta.path.length, 3);
  assert.equal(j2.meta.blocked, true);
  assert.equal(j2.meta.kind, 'closure');
  assert.equal(j2.meta.severity, 'critical');
  assert.equal(j2.meta.delayS, null);
});

test('a waze-server answer (flat latitude / longitude, subType) reads the same', () => {
  const list = parseWaze({
    alerts: [
      { type: 'ACCIDENT', subType: 'ACCIDENT_MINOR', latitude: 33.7, longitude: -84.4 },
      { type: 'POLICE', subType: 'POLICE_HIDING', latitude: 33.8, longitude: -84.3 },
    ],
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].meta.label, 'Minor accident');
  assert.equal(list[1].meta.label, 'Police (hidden)');
  assert.equal(list[0].id, 'waze/a/ACCIDENT:33.7,-84.4');
  assert.deepEqual(parseWaze(null), []);
  assert.deepEqual(parseWaze({ alerts: 'x', jams: {} }), []);
});

test('boxes snap to 0.01 degree, clip to a degree, and pick the server region', () => {
  const b = wazeBox({ lomin: -122.456, lamin: 37.701, lomax: -122.351, lamax: 37.809 });
  assert.deepEqual(b, {
    lomin: -122.46,
    lamin: 37.7,
    lomax: -122.35,
    lamax: 37.81,
    clipped: false,
  });
  const wide = wazeBox({ lomin: -125, lamin: 35, lomax: -119, lamax: 40 });
  assert.equal(wide.clipped, true);
  assert.ok(wide.lomax - wide.lomin <= 1.02 && wide.lamax - wide.lamin <= 1.02);
  assert.equal(wazeBox(null), null);
  assert.deepEqual(wazeQuery({ lomin: 2.3, lamin: 48.8, lomax: 2.4, lamax: 48.9 }), {
    top: '48.90',
    bottom: '48.80',
    left: '2.30',
    right: '2.40',
    env: 'row',
    types: 'alerts,traffic',
  });
  assert.deepEqual(wazeLocalQuery({ lomin: 2.3, lamin: 48.8, lomax: 2.4, lamax: 48.9 }), {
    latBottom: '48.80',
    latTop: '48.90',
    lonLeft: '2.30',
    lonRight: '2.40',
  });
  assert.equal(wazeEnv(40.7, -74), 'na');
  assert.equal(wazeEnv(-23.5, -46.6), 'na');
  assert.equal(wazeEnv(32.08, 34.78), 'il');
  assert.equal(wazeEnv(35.7, 139.7), 'row');
});

test('kinds, labels, glyphs and the card', () => {
  assert.equal(wazeKind('POLICE', ''), 'police');
  assert.equal(wazeKind('CHIT_CHAT', ''), null);
  assert.equal(wazeLabel('POLICE', ''), 'Police reported');
  assert.equal(wazeGlyph('police'), 'police');
  assert.equal(wazeKind('HAZARD', 'HAZARD_ON_ROAD_LANE_CLOSED'), 'closure');
  assert.equal(wazeKind('CONSTRUCTION', ''), 'roadworks');
  assert.equal(wazeLabel('HAZARD', 'HAZARD_ON_ROAD_SOMETHING_NEW'), 'Something new');
  assert.equal(wazeLabel('JAM', ''), 'Traffic jam');
  assert.equal(wazeGlyph('accident'), 'xmark');
  assert.equal(wazeGlyph('unknown'), 'triangle');
  assert.equal(reportedAgo(T - 6 * 60_000, T), '6 min ago');
  assert.equal(reportedAgo(T - 3 * 3600_000, T), '3 h ago');
  assert.equal(reportedAgo(null, T), null);
  const [a1, , , , , j1] = parseWaze(LIVE);
  const card = describeWaze(a1, T);
  assert.equal(card.title, 'Major accident');
  assert.equal(card.subtitle, 'Market St, San Francisco');
  const rows = Object.fromEntries(card.rows);
  assert.equal(rows['Confirmed by'], '4 drivers');
  assert.equal(rows.Reported, '6 min ago');
  assert.match(rows.Source, /unofficial/);
  assert.match(
    card.links[0].url,
    /^https:\/\/www\.waze\.com\/ul\?ll=37\.77000%2C-122\.41000/,
  );
  const jam = Object.fromEntries(describeWaze(j1, T).rows);
  assert.equal(jam.Level, '4 of 5 (Very heavy)');
  assert.equal(jam.Speed, '9 km/h');
  assert.equal(jam.Delay, '4 min');
});

test('the source asks the live map, or your waze-server when configured', async () => {
  const calls = [];
  const proxyClient = {
    getJson: async (feed, path, { params }) => {
      calls.push({ feed, path, params });
      return { alerts: [], jams: [] };
    },
  };
  const bbox = { lomin: -122.5, lamin: 37.7, lomax: -122.35, lamax: 37.82 };
  const live = await createWazeSource({ proxyClient })({ bbox });
  const local = await createWazeSource({ proxyClient, local: true })({ bbox });
  assert.deepEqual(
    calls.map((c) => [c.feed, c.path]),
    [
      ['waze', '/live-map/api/georss'],
      ['waze-local', '/waze/traffic-notifications'],
    ],
  );
  assert.equal(calls[0].params.types, 'alerts,traffic');
  assert.equal(live.via, 'live');
  assert.equal(local.via, 'local');
  const none = await createWazeSource({ proxyClient })({});
  assert.deepEqual(none.json, { alerts: [], jams: [] });
  assert.equal(calls.length, 2, 'no request without a view');
  const demo = await createWazeMockSource()({ bbox });
  assert.equal(parseWaze(demo.json).length, 11);
});
