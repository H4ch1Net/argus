// Signal counting against real data: OSM traffic_signals nodes around a San
// Francisco route (Overpass answer, fixtures/overpass-sf-signals.json) and the
// real OSRM and Valhalla routes through them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { osrm, valhalla, tomtom } from './providers.js';
import {
  SIGNAL_DELAY_S,
  annotateSignals,
  createSignalCache,
  parseSignalNodes,
  perSignalDelayS,
  signalsAlong,
  signalsQuery,
  tileBounds,
  tilesForLine,
} from './signals.js';

const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const nodes = parseSignalNodes(fixture('overpass-sf-signals.json'));

test('tiles: fixed 0.02 degree grid along the corridor, in route order', () => {
  assert.deepEqual(tileBounds('1888:-6121'), [37.76, -122.42, 37.78, -122.4]);
  const line = [
    [-122.419, 37.775],
    [-122.415, 37.759],
  ];
  assert.deepEqual(tilesForLine(line), ['1888:-6121', '1887:-6121']);
  // A line 10 m from a tile edge also takes the neighbouring tile (15 m corridor).
  assert.deepEqual(tilesForLine([[-122.41, 37.77991]]).sort(), [
    '1888:-6121',
    '1889:-6121',
  ]);
  const q = signalsQuery(['1888:-6121']);
  assert.equal(
    q,
    '[out:json][timeout:25];(node["highway"="traffic_signals"](37.76,-122.42,37.78,-122.4););out skel;',
  );
});

test('counts the signals on real routes, one per junction', () => {
  assert.equal(nodes.length, 85);
  const [r] = osrm.parse(fixture('osrm-sf-car.json'));
  const raw = signalsAlong(r.geometry, nodes, { mergeM: 0 });
  const along = signalsAlong(r.geometry, nodes);
  assert.equal(raw.length, 16, 'nodes within 15 m of the line');
  assert.equal(along.length, 9, 'junctions after merging approaches');
  for (let i = 1; i < along.length; i += 1) assert.ok(along[i] - along[i - 1] > 40);
  assert.ok(along.at(-1) <= r.distanceM + 5);
  // A line far from any node counts none; an empty node list none.
  assert.deepEqual(
    signalsAlong(
      [
        [0, 0],
        [0, 0.01],
      ],
      nodes,
    ),
    [],
  );
  assert.deepEqual(signalsAlong(r.geometry, []), []);
  // The Valhalla alternatives see their own counts.
  const [v0, , v2] = valhalla.parse(fixture('valhalla-sf-avoid.json'));
  assert.equal(signalsAlong(v0.geometry, nodes).length, 11);
  assert.equal(signalsAlong(v2.geometry, nodes).length, 12);
});

test('the tile cache asks once per tile, 12 tiles a query, and remembers', async () => {
  const asked = [];
  let t = 0;
  const cache = createSignalCache({
    now: () => t,
    fetchJson: async (ql) => {
      asked.push(ql);
      return fixture('overpass-sf-signals.json');
    },
  });
  const keys = ['1888:-6121', '1887:-6121'];
  const first = await cache.nodesFor(keys);
  // Nodes land in the tile they are in: the fixture also covers a strip west
  // of these two tiles, which stays out.
  assert.equal(first.length, 74);
  assert.equal(asked.length, 1);
  await cache.nodesFor(keys);
  assert.equal(asked.length, 1, 'cached');
  // Two callers at once share the request.
  t += 7 * 60 * 60 * 1000;
  await Promise.all([cache.nodesFor(keys), cache.nodesFor(keys)]);
  assert.equal(asked.length, 2, 'refetched once after the TTL');
  const many = Array.from({ length: 30 }, (_, i) => `${1800 + i}:-6121`);
  await cache.nodesFor(many);
  assert.equal(asked.length, 5, '30 tiles in three queries');
  // Overpass overload (a remark, no elements) is a failure, not an empty tile.
  const busy = createSignalCache({
    fetchJson: async () => ({ remark: 'runtime error: timeout', elements: [] }),
  });
  await assert.rejects(busy.nodesFor(['1:1']), /Overpass: runtime error/);
});

test('annotateSignals fills the count and delay; TomTom traffic times add none', async () => {
  const cache = createSignalCache({
    fetchJson: async () => fixture('overpass-sf-signals.json'),
  });
  const [r] = osrm.parse(fixture('osrm-sf-car.json'));
  await annotateSignals(r, cache);
  assert.equal(r.signals, 9);
  assert.equal(r.signalDelayS, 9 * SIGNAL_DELAY_S.drive);
  assert.equal(r.signalsAlongM.length, 9);
  const [t] = tomtom.parse(fixture('tomtom-route-documented.json'), { traffic: true });
  await annotateSignals(t, cache);
  assert.equal(t.signals, 9);
  assert.equal(t.signalDelayS, 0);
  assert.equal(perSignalDelayS({ provider: 'osrm', mode: 'walk' }), SIGNAL_DELAY_S.walk);
});
