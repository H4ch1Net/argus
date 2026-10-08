import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITIES, searchPlaces, findPlace, normalizePlaceName } from './places.js';

test('the bundled list: ~400 places, valid rows, rank-ordered, no duplicates', () => {
  assert.ok(CITIES.length >= 380 && CITIES.length <= 460, `${CITIES.length} places`);
  let prevRank = 1;
  const seen = new Set();
  for (const row of CITIES) {
    const [name, lat, lon, rank, country] = row;
    assert.equal(row.length, 5, name);
    assert.ok(typeof name === 'string' && name.length > 1, name);
    assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180, name);
    assert.ok([1, 2, 3].includes(rank), name);
    assert.ok(rank >= prevRank, `${name} is out of rank order`);
    assert.equal(typeof country, 'string');
    prevRank = rank;
    const key = `${name}|${country}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
  }
});

test('names normalize without accents, apostrophes or "saint"', () => {
  assert.equal(normalizePlaceName('  São Paulo '), 'sao paulo');
  assert.equal(normalizePlaceName("N'Djamena"), 'ndjamena');
  assert.equal(normalizePlaceName('Chișinău'), 'chisinau');
  assert.equal(normalizePlaceName('Saint Petersburg'), 'st petersburg');
  assert.equal(normalizePlaceName('St. Louis'), 'st louis');
});

test('exact names, "name, country" and aliases resolve offline', () => {
  assert.deepEqual(findPlace('paris'), {
    name: 'Paris, France',
    latitude: 48.86,
    longitude: 2.35,
    rank: 1,
    exact: true,
    source: 'offline',
  });
  assert.equal(findPlace('Sao Paulo').name, 'São Paulo, Brazil');
  assert.equal(findPlace('Paris, France').name, 'Paris, France');
  assert.equal(findPlace('NYC').name, 'New York, United States');
  assert.equal(findPlace('bombay').name, 'Mumbai, India');
  assert.equal(findPlace('kiev').name, 'Kyiv, Ukraine');
  assert.equal(findPlace('Saint Petersburg').name, 'St Petersburg, Russia');
  assert.equal(findPlace('singapore').name, 'Singapore');
  // Not an exact name: no offline answer, so the network geocoder is asked.
  assert.equal(findPlace('Paris, Texas'), null);
  assert.equal(findPlace('Lond'), null);
  assert.equal(findPlace(''), null);
});

test('searchPlaces ranks exact, then prefix, then word prefix; larger places first', () => {
  const lon = searchPlaces('lon');
  assert.equal(lon[0].name, 'London, United Kingdom');
  assert.equal(lon[0].exact, false);
  assert.ok(searchPlaces('petersburg').some((p) => p.name.startsWith('St Petersburg')));
  // Two exact matches for one name both come back.
  const sj = searchPlaces('san jose').map((p) => p.name);
  assert.ok(
    sj.includes('San Jose, United States') && sj.includes('San José, Costa Rica'),
  );
  assert.equal(searchPlaces('san', { limit: 3 }).length, 3);
  assert.deepEqual(searchPlaces('x'), []);
  assert.deepEqual(searchPlaces('zzzz'), []);
  // Every result carries the geocoder result shape.
  for (const p of searchPlaces('ca')) {
    assert.equal(typeof p.name, 'string');
    assert.ok(Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
    assert.equal(p.source, 'offline');
  }
});
