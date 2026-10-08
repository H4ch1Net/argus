import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latBand, toDms, toMgrs, toUtm, utmZone } from './mgrs.js';

// Expected values: the canonical vectors are published (0,0 is the standard
// MGRS library test vector; Baghdad is GeographicLib's GeoConvert example; the
// Washington Monument is the USNG example). The rest were computed here and
// cross-checked against an independent implementation (the Snyder / USGS
// series with separately written letter logic), which agreed to the millimetre.

test('canonical vector: 0,0 is 31N AA 66021 00000', () => {
  assert.equal(toMgrs(0, 0), '31N AA 66021 00000');
  const u = toUtm(0, 0);
  assert.equal(u.zone, 31);
  assert.ok(Math.abs(u.easting - 166021.443) < 0.001);
  assert.ok(Math.abs(u.northing) < 1e-6);
});

test('published examples: Baghdad 38SMB4484, Washington Monument 18SUJ23480647', () => {
  assert.equal(toMgrs(33.3, 44.4, 2), '38S MB 44 84');
  assert.equal(toMgrs(38.88947, -77.03524, 4), '18S UJ 2348 0647');
});

test('northern hemisphere landmarks', () => {
  assert.equal(toMgrs(48.8584, 2.2945), '31U DQ 48252 11954'); // Eiffel Tower
  assert.equal(toMgrs(40.6892, -74.0445), '18T WL 80735 04695'); // Statue of Liberty
  assert.equal(toMgrs(48.8566, 2.3522), '31U DQ 52482 11717'); // Paris centre
});

test('southern hemisphere uses the 10,000 km false northing', () => {
  assert.equal(toMgrs(-33.8568, 151.2153), '56H LH 34900 52288'); // Sydney Opera House
  assert.equal(toMgrs(-22.9519, -43.2105), '23K PQ 83476 60687'); // Cristo Redentor
  assert.equal(toMgrs(-41.2865, 174.7762), '60G UV 13781 27052'); // Wellington
  const u = toUtm(-33.8568, 151.2153);
  assert.equal(u.hemisphere, 'S');
  assert.ok(u.northing > 6_000_000 && u.northing < 10_000_000);
});

test('Norway exception: 32V is widened west to 3E', () => {
  assert.equal(utmZone(60.39, 5.32), 32); // Bergen: zone 31 by longitude alone
  assert.equal(toMgrs(60.39, 5.32), '32V KN 97230 00510');
  assert.equal(utmZone(60.39, 2.99), 31);
  assert.equal(utmZone(60.39, 12.01), 33);
  assert.equal(utmZone(55.99, 5.32), 31); // band U, south of the exception
  assert.equal(utmZone(64.01, 5.32), 31); // band W, north of it
});

test('Svalbard exception: band X uses zones 31, 33, 35, 37 only', () => {
  assert.equal(toMgrs(78.2232, 15.6267), '33X WG 14278 83355'); // Longyearbyen
  assert.equal(utmZone(78, 8.99), 31);
  assert.equal(utmZone(78, 9.01), 33);
  assert.equal(utmZone(78, 20.99), 33);
  assert.equal(utmZone(78, 21), 35);
  assert.equal(utmZone(78, 33), 37);
  assert.equal(utmZone(78, 41.99), 37);
  assert.equal(utmZone(78, 42), 38);
  assert.equal(utmZone(71.99, 10), 32); // band W: ordinary zoning
  assert.equal(utmZone(84, 10), 33); // the top edge of X is still X
});

test('latitude bands, including the stretched X', () => {
  assert.equal(latBand(-80), 'C');
  assert.equal(latBand(-72.0001), 'C');
  assert.equal(latBand(-72), 'D');
  assert.equal(latBand(-0.0001), 'M');
  assert.equal(latBand(0), 'N');
  assert.equal(latBand(71.99), 'W');
  assert.equal(latBand(72), 'X');
  assert.equal(latBand(84), 'X');
  assert.equal(latBand(84.01), null);
  assert.equal(latBand(-80.01), null);
});

test('null outside -80..84 latitude and for bad input', () => {
  assert.equal(toMgrs(84.01, 0), null);
  assert.equal(toMgrs(-80.01, 0), null);
  assert.equal(toMgrs(90, 0), null);
  assert.equal(toMgrs(NaN, 0), null);
  assert.equal(toMgrs(0, Infinity), null);
  assert.ok(toMgrs(84, 10).startsWith('33X '));
  assert.ok(toMgrs(-80, 10).startsWith('32C '));
});

test('precision truncates, never rounds', () => {
  assert.equal(toMgrs(48.8584, 2.2945, 4), '31U DQ 4825 1195');
  assert.equal(toMgrs(48.8584, 2.2945, 1), '31U DQ 4 1');
  assert.equal(toMgrs(48.8584, 2.2945, 0), '31U DQ');
  // Every coarser reference is a prefix of the finer one, axis by axis.
  const [gzd, sq, e5, n5] = toMgrs(-22.9519, -43.2105, 5).split(' ');
  for (let p = 1; p <= 4; p++) {
    assert.equal(
      toMgrs(-22.9519, -43.2105, p),
      `${gzd} ${sq} ${e5.slice(0, p)} ${n5.slice(0, p)}`,
    );
  }
});

test('antimeridian: 180 and -180 are the same place, zone 1', () => {
  assert.equal(utmZone(10, 180), 1);
  assert.equal(toMgrs(10, 180), toMgrs(10, -180));
  assert.equal(utmZone(10, 179.999), 60);
});

test('well-formed output across the globe', () => {
  const re = /^([1-9]|[1-5]\d|60)[C-HJ-NP-X] [A-HJ-NP-Z][A-HJ-NP-V] \d{5} \d{5}$/;
  for (let lat = -80; lat <= 84; lat += 3.7) {
    for (let lon = -180; lon < 180; lon += 7.3) {
      const s = toMgrs(lat, lon);
      assert.match(s, re, `${lat},${lon} -> ${s}`);
      const { easting } = toUtm(lat, lon);
      assert.ok(easting > 100000 && easting < 900000, `${lat},${lon} easting ${easting}`);
    }
  }
});

test('toDms formats degrees, minutes and rounded seconds', () => {
  assert.equal(toDms(48.8566, 2.3522), `48°51'24"N 002°21'08"E`);
  assert.equal(toDms(-33.8568, -70.6693), `33°51'24"S 070°40'09"W`);
  assert.equal(toDms(0, 0), `00°00'00"N 000°00'00"E`);
  // Rounding carries into minutes and degrees.
  assert.equal(toDms(48.99999, 2.99999), `49°00'00"N 003°00'00"E`);
  // A value that rounds to zero takes no hemisphere sign.
  assert.equal(toDms(-0.0000001, -0.0000001), `00°00'00"N 000°00'00"E`);
  assert.equal(toDms(10, -180), `10°00'00"N 180°00'00"E`);
  assert.equal(toDms(NaN, 0), '');
});
