import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_POIS, POI_VIEW_DEFAULTS, poiView, searchPois, poisNear } from './pois.js';

test('the landmark list: valid cities and views, unique names', () => {
  assert.equal(CITY_POIS.length, 9);
  const ids = new Set();
  for (const c of CITY_POIS) {
    assert.ok(!ids.has(c.id), `duplicate ${c.id}`);
    ids.add(c.id);
    assert.ok(Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180, c.city);
    assert.ok(c.pois.length >= 4, c.city);
    const names = new Set();
    for (const p of c.pois) {
      assert.ok(!names.has(p.name), `duplicate ${p.name}`);
      names.add(p.name);
      // Each landmark lies within 20 km of its city's centre.
      const dKm = Math.hypot(
        (p.lat - c.lat) * 111,
        (p.lon - c.lon) * 111 * Math.cos((c.lat * Math.PI) / 180),
      );
      assert.ok(dKm < 20, `${p.name} is ${dKm.toFixed(1)} km out`);
      assert.ok(p.alt >= 100 && p.alt <= 5000, p.name);
      assert.ok(p.heading >= 0 && p.heading < 360, p.name);
      assert.ok(p.pitch < 0 && p.pitch > -90, p.name);
      assert.ok(p.targetM >= 0, p.name);
    }
  }
  assert.ok(Object.isFrozen(CITY_POIS) && Object.isFrozen(CITY_POIS[0].pois[0]));
});

test('the reference views are kept as they were', () => {
  const eiffel = CITY_POIS.find((c) => c.id === 'paris').pois[0];
  assert.deepEqual(eiffel, {
    name: 'Eiffel Tower',
    lat: 48.8584,
    lon: 2.2945,
    alt: 750,
    heading: 315,
    pitch: -25,
    targetM: 150,
  });
});

test('poiView fills the defaults (range 1500 m, pitch -35)', () => {
  assert.deepEqual(poiView({ lat: 1, lon: 2 }), { lat: 1, lon: 2, ...POI_VIEW_DEFAULTS });
  assert.deepEqual(POI_VIEW_DEFAULTS, { alt: 1500, heading: 0, pitch: -35, targetM: 0 });
  assert.deepEqual(poiView(CITY_POIS[0].pois[0]), {
    lon: -97.7403,
    lat: 30.2747,
    alt: 550,
    heading: 180,
    pitch: -28,
    targetM: 35,
  });
});

test('searchPois: names, city + name, any word order, accents and ligatures', () => {
  const first = (q) => searchPois(q)[0]?.name;
  assert.equal(first('eiffel tower'), 'Eiffel Tower');
  assert.equal(searchPois('Eiffel Tower')[0].exact, true);
  assert.equal(first('EIFFEL'), 'Eiffel Tower');
  assert.equal(first('paris eiffel'), 'Eiffel Tower');
  assert.equal(first('eiffel paris'), 'Eiffel Tower');
  assert.equal(first('liberty statue'), 'Statue of Liberty');
  assert.equal(first('nyc empire'), 'Empire State Building');
  assert.equal(first('shard'), 'The Shard');
  assert.equal(searchPois('the shard')[0].exact, true);
  assert.equal(first('london the shard'), 'The Shard');
  assert.equal(first('sacre coeur'), 'Sacré-Cœur');
  assert.equal(first('Sacré-Cœur'), 'Sacré-Cœur');
  assert.equal(first('ulemiste'), 'Ülemiste');
  assert.equal(first('teatri valjak'), 'Teatri väljak');
  assert.equal(first('saint pauls'), "St. Paul's Cathedral");
  assert.equal(first('big ben'), 'Big Ben / Parliament');
  const hit = searchPois('golden gate')[0];
  assert.equal(hit.city, 'San Francisco');
  assert.equal(hit.cityId, 'sf');
  assert.equal(hit.label, 'Golden Gate Bridge, San Francisco');
  assert.equal(hit.alt, 1400);
});

test('searchPois: ranking, a bare city, limits and misses', () => {
  // A name prefix beats a city-only match.
  const dc = searchPois('washington', { limit: 10 });
  assert.equal(dc[0].name, 'Washington Monument');
  assert.equal(dc.length, 5);
  assert.ok(dc.every((p) => p.cityId === 'dc'));
  // A bare city lists its landmarks in the reference's order.
  assert.deepEqual(
    searchPois('tokyo', { limit: 10 }).map((p) => p.name),
    [
      'Tokyo Tower',
      'Tokyo Skytree',
      'Imperial Palace',
      'Senso-ji Temple',
      'Mode Gakuen Cocoon Tower',
    ],
  );
  assert.equal(searchPois('tower', { limit: 3 }).length, 3);
  assert.deepEqual(searchPois('e'), []);
  assert.deepEqual(searchPois(''), []);
  assert.deepEqual(searchPois('zzzz'), []);
  assert.deepEqual(searchPois('paris zzzz'), []);
});

test('poisNear: within the radius, nearest first', () => {
  const near = poisNear(51.5045, -0.0865, 1.5);
  assert.equal(near[0].name, 'The Shard');
  assert.ok(near[0].distanceKm < 0.01);
  assert.ok(near.every((p, i) => i === 0 || p.distanceKm >= near[i - 1].distanceKm));
  assert.ok(near.every((p) => p.distanceKm <= 1.5 && p.cityId === 'london'));
  assert.deepEqual(
    near.map((p) => p.name),
    ['The Shard', 'Tower Bridge', 'The Gherkin', "St. Paul's Cathedral"],
  );
  assert.deepEqual(poisNear(0, 0, 50), []);
  assert.deepEqual(poisNear(NaN, 0, 50), []);
  assert.equal(poisNear(48.8584, 2.2945).length, 5, 'default radius 25 km');
});
