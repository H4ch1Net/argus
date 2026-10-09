import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixSource } from './fixSource.js';

function fakeGeolocation(coords) {
  const watches = new Map();
  let next = 1;
  return {
    watches,
    getCurrentPosition: (ok) => ok({ coords, timestamp: 5 }),
    watchPosition(ok) {
      const id = next++;
      watches.set(id, ok);
      return id;
    },
    clearWatch: (id) => watches.delete(id),
    emit(c) {
      for (const fn of watches.values()) fn({ coords: c, timestamp: 9 });
    },
  };
}

test('browser fallback: locate, then watch until stopped', async () => {
  const geo = fakeGeolocation({
    latitude: 1,
    longitude: 2,
    accuracy: 7,
    heading: NaN,
    speed: 3,
  });
  const fixes = createFixSource({ selfPosition: null, geolocation: geo });
  assert.equal(fixes.get(), null);
  const f = await fixes.locate();
  assert.deepEqual(f, {
    lat: 1,
    lon: 2,
    accuracy: 7,
    heading: null,
    speed: 3,
    t: 5,
    source: 'geolocation',
  });
  assert.equal(fixes.get(), f);
  const seen = [];
  const stop = fixes.watch((x) => seen.push(x));
  geo.emit({ latitude: 1.1, longitude: 2.1 });
  assert.equal(seen[0].lat, 1.1);
  stop();
  assert.equal(geo.watches.size, 0);
  assert.equal(fixes.native, false);
});

test('the app self position wins when there is one', async () => {
  const subs = new Set();
  let started = 0;
  const sp = {
    get: () => ({ lat: 5, lon: 6, t: 1, source: 'gps' }),
    locate: async () => ({ lat: 5, lon: 6, t: 1, source: 'gps' }),
    start: () => (started += 1),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  const fixes = createFixSource({ selfPosition: () => sp, geolocation: null });
  assert.equal(fixes.native, true);
  assert.equal(fixes.get().source, 'gps');
  assert.equal((await fixes.locate()).lat, 5);
  const seen = [];
  const stop = fixes.watch((f) => seen.push(f));
  assert.equal(started, 1);
  for (const fn of subs) fn({ lat: 7, lon: 8 });
  assert.equal(seen[0].lat, 7);
  stop();
  assert.equal(subs.size, 0);
});
