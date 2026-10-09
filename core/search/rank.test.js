import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  placeTokens,
  textScore,
  distanceKm,
  distancePenalty,
  kindBonus,
  placeScore,
  rankPlaces,
  LOCAL_RADIUS_KM,
} from './rank.js';
import { photonPlaces } from '../nav/search.js';

const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(new URL(`../nav/fixtures/${name}`, import.meta.url), 'utf8'),
  );
const INDIO = { lat: 33.72, lon: -116.21 };

test('tokens: case, accents and street words fold to one spelling', () => {
  assert.deepEqual(placeTokens('46211 Jackson Street'), ['46211', 'jackson', 'st']);
  assert.deepEqual(placeTokens('46211 JACKSON ST, INDIO'), [
    '46211',
    'jackson',
    'st',
    'indio',
  ]);
  assert.deepEqual(placeTokens('Île-de-France North Avenue'), [
    'ile',
    'de',
    'france',
    'n',
    'ave',
  ]);
  assert.deepEqual(placeTokens(null), []);
});

test('text score: exact, starts with, all words, partial; a missing house number costs', () => {
  assert.equal(textScore('jackson street', 'Jackson St'), 1);
  assert.equal(textScore('walmart', 'Walmart Supercenter'), 0.95);
  assert.equal(textScore('walmart super', 'Walmart Supercenter'), 0.95); // half typed
  assert.equal(textScore('ferry building', 'The Ferry Building'), 0.75);
  assert.equal(textScore('main st indio', 'Main Street', 'Indio, California'), 0.65);
  // The street without the number is not the address.
  const street = textScore('46211 jackson street', 'Jackson Street', 'Coachella');
  assert.ok(street < 0.5, String(street));
  assert.equal(textScore('46211 jackson street', '46211 Jackson St', 'Indio, CA'), 1);
  assert.equal(textScore('', 'Anything'), 0);
});

test('distance: square-root cost to 0.3 at the local radius, flat beyond it', () => {
  assert.equal(distancePenalty(null), 0);
  assert.equal(distancePenalty(0), 0);
  assert.ok(Math.abs(distancePenalty(LOCAL_RADIUS_KM) - 0.3) < 1e-12);
  assert.equal(distancePenalty(9000), distancePenalty(LOCAL_RADIUS_KM));
  assert.ok(distancePenalty(1) < distancePenalty(25));
  assert.ok(Math.abs(distanceKm(33.72, -116.21, 39.1, -84.5) - 2850) < 50);
});

test('settlements named as typed get a bonus that outweighs distance', () => {
  assert.equal(kindBonus('place=city'), 0.35);
  assert.equal(kindBonus('place=town'), 0.3);
  assert.equal(kindBonus('place=hamlet'), 0.1);
  assert.equal(kindBonus('shop=supermarket'), 0);
  // "Fresno" from Indio: the city 400 km away, not a street named Fresno
  // in Tijuana (140 km), as Photon answered (live, Oct 2026).
  const city = { name: 'Fresno', kind: 'place=city', lat: 36.74, lon: -119.78 };
  const street = {
    name: 'Fresno',
    kind: 'highway=residential',
    lat: 32.48,
    lon: -116.95,
  };
  const km = (p) => distanceKm(INDIO.lat, INDIO.lon, p.lat, p.lon);
  assert.ok(
    placeScore('fresno', city, km(city)) > placeScore('fresno', street, km(street)),
  );
  // No bonus for a partial match.
  assert.equal(
    placeScore('fresno pacific', city, 0),
    textScore('fresno pacific', 'Fresno'),
  );
});

test('near beats far for a similar match (real Photon answer: walmart near Indio)', () => {
  const places = photonPlaces(fixture('photon-walmart-indio.json'));
  // Photon's own order leads with Palm Springs (25 km) and San Jacinto (70 km).
  assert.equal(places[0].detail.includes('Palm Springs'), true);
  const ranked = rankPlaces('walmart', places, { near: INDIO });
  assert.match(ranked[0].name, /^Walmart/);
  assert.ok(distanceKm(INDIO.lat, INDIO.lon, ranked[0].lat, ranked[0].lon) < 5);
  // San Jacinto (70 km away, same text) sinks below every local store.
  const sj = ranked.findIndex((p) => /San Jacinto/.test(p.detail));
  assert.ok(sj >= ranked.length - 2, String(sj));
  // Without a position Photon's order stands.
  assert.deepEqual(
    rankPlaces('walmart', places)
      .map((p) => p.id)
      .slice(0, 2),
    [places[0].id, places[1].id],
  );
});

test('a far result wins only with a clearly better text match', () => {
  const near = { name: 'Jackson Street', detail: 'Indio', lat: 33.74, lon: -116.22 };
  const farExact = {
    name: '46211 Jackson St',
    detail: 'Elsewhere',
    lat: 39.1,
    lon: -84.5,
  };
  assert.equal(
    rankPlaces('46211 jackson street', [near, farExact], { near: INDIO })[0],
    farExact,
  );
  const farSame = { name: 'Jackson Street', detail: 'Cincinnati', lat: 39.1, lon: -84.5 };
  assert.equal(rankPlaces('jackson street', [farSame, near], { near: INDIO })[0], near);
});

test('the same name within 200 m is kept once; bad points are skipped', () => {
  const a = { name: '46211 Jackson St', lat: 33.71306, lon: -116.21643 };
  const b = { name: '46211 Jackson Street', lat: 33.713, lon: -116.21646 };
  const c = { name: 'Elsewhere', lat: NaN, lon: 0 };
  assert.deepEqual(rankPlaces('46211 jackson st', [a, b, c]), [a]);
  assert.equal(rankPlaces('x', [a, b], { limit: 1 }).length, 1);
});
