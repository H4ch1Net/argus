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

test('HOME and WORK: one place each; a new one makes the old a plain place', () => {
  const s = createPlacesStore(memory());
  const a = s.add({
    name: '46211 Jackson St',
    lat: 33.71306,
    lon: -116.21643,
    kind: 'home',
  });
  const b = s.add({ name: 'Old house', lat: 33.7, lon: -116.2, kind: 'home' });
  assert.equal(s.role('home').id, b.id);
  assert.equal(s.get(a.id).kind, 'place');
  s.setRole(a.id, 'home');
  assert.equal(s.role('home').id, a.id);
  assert.equal(s.get(b.id).kind, 'place');
  s.setRole(b.id, 'work');
  assert.equal(s.role('work').id, b.id);
  s.setRole(b.id, null);
  assert.equal(s.role('work'), null);
  assert.equal(s.get(b.id).kind, 'place');
  // "home" finds the place holding the role, whatever its name.
  assert.equal(s.search('home')[0].id, a.id);
  assert.equal(s.setRole('nope', 'home'), null);
});

test('near: the saved place at a point (within 30 m by default)', () => {
  const s = createPlacesStore(memory());
  const p = s.add({ name: 'Crossing', lat: 33.71491, lon: -116.21028 });
  assert.equal(s.near(33.71491, -116.2103)?.id, p.id); // 2 m
  assert.equal(s.near(33.7152, -116.21028), null); // 32 m
  assert.equal(s.near(33.7152, -116.21028, 50)?.id, p.id);
  assert.equal(s.near(NaN, 1), null);
});

test('another page of the origin changed the list: refresh and storage events', () => {
  const st = memory();
  const listeners = [];
  const events = { addEventListener: (type, fn) => listeners.push([type, fn]) };
  const phone = createPlacesStore(st);
  const car = createPlacesStore(st, { events });
  let heard = 0;
  car.subscribe(() => (heard += 1));
  phone.add({ name: 'Gym', lat: 33.7, lon: -116.2 });
  assert.equal(car.list().length, 0); // not read yet
  assert.equal(car.refresh(), true);
  assert.equal(car.list()[0].name, 'Gym');
  assert.equal(car.refresh(), false); // nothing new
  phone.add({ name: 'Work', lat: 33.8, lon: -116.3, kind: 'work' });
  const [type, onStorage] = listeners[0];
  assert.equal(type, 'storage');
  onStorage({ key: PLACES_KEY });
  assert.equal(car.role('work').name, 'Work');
  assert.equal(heard, 2);
  onStorage({ key: 'something.else' });
  assert.equal(heard, 2);
});

test('an imported HOME does not take the role from this device', () => {
  const a = createPlacesStore(memory());
  a.add({ name: 'Their home', lat: 1, lon: 1, kind: 'home' });
  const b = createPlacesStore(memory());
  b.add({ name: 'My home', lat: 2, lon: 2, kind: 'home' });
  assert.equal(b.import(a.export()), 1);
  assert.equal(b.role('home').name, 'My home');
  assert.equal(b.list().find((p) => p.name === 'Their home').kind, 'place');
});

test('a place becomes a map record and a card', () => {
  const p = validatePlace({ name: 'Tower', lat: 10, lon: 20, note: 'look east' });
  const n = placeToNormalized(p);
  assert.equal(n.position.latitude, 10);
  const card = describePlace(n);
  assert.equal(card.title, 'Tower');
  assert.ok(card.rows.some(([k, v]) => k === 'Note' && v === 'look east'));
});
