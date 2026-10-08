import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPlacesStore,
  validatePlace,
  placeToNormalized,
  describePlace,
  PLACES_KEY,
} from './saved.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m };
};

test('places are validated: bad positions and names are refused, text cleaned', () => {
  assert.equal(validatePlace({ name: 'x', lat: 91, lon: 0 }), null);
  assert.equal(validatePlace({ name: '', lat: 1, lon: 1 }), null);
  const p = validatePlace({
    name: '  Home\nbase  ',
    lat: 1,
    lon: 2,
    kind: 'home',
    view: { lat: 1, lon: 2, alt: 500 },
  });
  assert.equal(p.name, 'Home base');
  assert.equal(p.kind, 'home');
  assert.equal(p.view.alt, 500);
  assert.equal(
    validatePlace({ name: 'a', lat: 1, lon: 1, kind: 'secret' }).kind,
    'place',
  );
});

test('the store adds, updates, searches, removes and persists', () => {
  const st = memory();
  const s = createPlacesStore(st);
  const a = s.add({ name: 'Café Corner', lat: 48.85, lon: 2.35 });
  s.add({ name: 'Harbour cam', lat: 51.5, lon: -0.1, kind: 'camera', note: 'pier view' });
  assert.equal(s.list().length, 2);
  assert.equal(s.search('cafe')[0].id, a.id);
  assert.equal(s.search('pier')[0].name, 'Harbour cam');
  s.update(a.id, { name: 'Café' });
  assert.equal(createPlacesStore(st).get(a.id).name, 'Café');
  s.remove(a.id);
  assert.equal(createPlacesStore(st).list().length, 1);
  st.m.set(PLACES_KEY, 'garbage');
  assert.deepEqual(createPlacesStore(st).list(), []);
});

test('export and import merge without duplicates', () => {
  const a = createPlacesStore(memory());
  a.add({ name: 'One', lat: 1, lon: 1 });
  a.add({ name: 'Two', lat: 2, lon: 2 });
  const b = createPlacesStore(memory());
  b.add({ name: 'One', lat: 1, lon: 1 });
  assert.equal(b.import(a.export()), 1);
  assert.equal(b.list().length, 2);
  assert.equal(b.import('{"v":2}'), 0);
});

test('a place becomes a map record and a card', () => {
  const p = validatePlace({ name: 'Tower', lat: 10, lon: 20, note: 'look east' });
  const n = placeToNormalized(p);
  assert.equal(n.position.latitude, 10);
  const card = describePlace(n);
  assert.equal(card.title, 'Tower');
  assert.ok(card.rows.some(([k, v]) => k === 'Note' && v === 'look east'));
});
