import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGeofences, haversineM } from './geofence.js';

test('distance is about 111 km per degree of latitude', () => {
  assert.ok(Math.abs(haversineM(0, 0, 1, 0) - 111_195) < 50);
});

test('contacts entering and leaving an area are reported once each', () => {
  const events = [];
  const g = createGeofences({
    onEnter: (a, c) => events.push(['in', a.name, c.id]),
    onExit: (a, k) => events.push(['out', a.name, k]),
  });
  const id = g.add({ name: 'PORT', lat: 10, lon: 10, radiusM: 5000 });
  assert.ok(id);
  const inside = { key: 'ships', id: 'A', lat: 10.01, lon: 10 };
  const outside = { key: 'ships', id: 'B', lat: 11, lon: 10 };
  g.check([inside, outside]);
  g.check([inside, outside]);
  assert.deepEqual(events, [['in', 'PORT', 'A']]);
  assert.equal(g.list()[0].count, 1);
  g.check([{ ...inside, lat: 10.2 }]);
  assert.deepEqual(events.at(-1), ['out', 'PORT', 'ships:A']);
  g.remove(id);
  assert.equal(g.size, 0);
  assert.equal(g.add({ name: 'bad', lat: NaN, lon: 0, radiusM: 1 }), null);
});
