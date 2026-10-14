import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecents, validateRecent, RECENTS_KEY } from './recents.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m };
};

test('recent destinations: newest first, the same place once, bounded', () => {
  const st = memory();
  const r = createRecents(st, { max: 3 });
  r.add({
    id: 'x:1',
    name: 'Highway 111 & Golf Center Parkway',
    lat: 33.71491,
    lon: -116.21028,
  });
  r.add({ id: 'osm:W1', name: 'Jackson Street', lat: 33.7131, lon: -116.2164 });
  // The same crossing again (another id, 20 m away): moves to the top.
  r.add({ id: 'x:2', name: 'Hwy 111 & Golf Center', lat: 33.71509, lon: -116.21028 });
  assert.deepEqual(
    r.list().map((p) => p.name),
    ['Hwy 111 & Golf Center', 'Jackson Street'],
  );
  r.add({ name: 'A', lat: 1, lon: 1 });
  r.add({ name: 'B', lat: 2, lon: 2 });
  assert.equal(r.list().length, 3);
  // Another page (the car's) reads the same list.
  assert.equal(createRecents(st).list()[0].name, 'B');
  r.remove(r.list()[0].id);
  assert.equal(r.list()[0].name, 'A');
  r.clear();
  assert.deepEqual(r.list(), []);
  st.m.set(RECENTS_KEY, '{bad');
  assert.deepEqual(r.list(), []);
});

test('records are validated', () => {
  assert.equal(validateRecent({ name: '', lat: 1, lon: 1 }), null);
  assert.equal(validateRecent({ name: 'x', lat: 100, lon: 1 }), null);
  const p = validateRecent({ name: ' Two\nlines ', lat: 1, lon: 2 });
  assert.equal(p.name, 'Two lines');
  assert.equal(p.id, '1.00000,2.00000');
  assert.equal(p.kind, 'place');
});
