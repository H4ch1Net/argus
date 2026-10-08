import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMode,
  checkRoutePoints,
  routePath,
  routeQuery,
  routeRequest,
  parseRoute,
  routeErrorMessage,
  normalizeSteps,
  instructionFor,
  roadLabel,
  stepIndexAtDistance,
  alongRoute,
  bearingDeg,
  formatRouteDistance,
  formatRouteDuration,
  ROUTE_STEPS_MAX,
  ROUTE_ATTRIBUTION,
  FIX_THE_MAP_URL,
} from './osrm.js';

const LONDON = { lat: 51.5074, lon: -0.1278 };
const OXFORD = { lat: 51.752, lon: -1.2577 };
const PARIS = { lat: 48.8566, lon: 2.3522 };

test('modes normalize from chip words and OSRM names', () => {
  assert.equal(normalizeMode('DRIVE'), 'car');
  assert.equal(normalizeMode('driving'), 'car');
  assert.equal(normalizeMode('walk'), 'foot');
  assert.equal(normalizeMode('cycling'), 'bike');
  assert.equal(normalizeMode('plane'), null);
  assert.equal(normalizeMode(undefined), null);
});

test('route path pairs each service with its profile and writes lon,lat', () => {
  assert.equal(
    routePath('car', [LONDON, OXFORD]),
    '/routed-car/route/v1/driving/-0.1278,51.5074;-1.2577,51.752',
  );
  assert.match(routePath('walk', [LONDON, OXFORD]), /^\/routed-foot\/route\/v1\/foot\//);
  assert.match(routePath('bike', [LONDON, OXFORD]), /^\/routed-bike\/route\/v1\/bike\//);
  // Accepts {latitude, longitude} too, and rounds to 6 decimals.
  assert.equal(
    routePath('car', [
      { latitude: 1.123456789, longitude: 2.5 },
      { latitude: 1.2, longitude: 2.6 },
    ]),
    '/routed-car/route/v1/driving/2.5,1.123457;2.6,1.2',
  );
  assert.throws(() => routePath('boat', [LONDON, OXFORD]), /unknown travel mode/);
  assert.deepEqual(routeQuery(), {
    overview: 'full',
    geometries: 'geojson',
    alternatives: 'false',
    steps: 'true',
  });
  assert.equal(routeQuery({ steps: false }).steps, 'false');
  const r = routeRequest('foot', [LONDON, OXFORD]);
  assert.equal(r.feed, 'osrm');
  assert.equal(r.params.geometries, 'geojson');
});

test('legs are checked before anyone is asked', () => {
  assert.equal(checkRoutePoints([LONDON]).ok, false);
  assert.equal(checkRoutePoints(Array(13).fill(LONDON)).ok, false);
  assert.equal(
    checkRoutePoints([LONDON, { lat: 95, lon: 0 }]).error,
    'invalid coordinate',
  );
  const ok = checkRoutePoints([LONDON, PARIS]);
  assert.equal(ok.ok, true);
  assert.ok(Math.abs(ok.totalKm - 343.5) < 2, `London-Paris ~343 km, got ${ok.totalKm}`);
  // London to Madrid is ~1,260 km in one leg: refused.
  assert.match(
    checkRoutePoints([LONDON, { lat: 40.4168, lon: -3.7038 }]).error,
    /leg too long/,
  );
  // Five legs of ~550 km each are each fine, but the total is not.
  const hops = [0, 5, 10, 15, 20, 25].map((lon) => ({ lat: 0, lon }));
  assert.match(checkRoutePoints(hops).error, /route too long/);
  assert.throws(
    () => routePath('car', [LONDON, { lat: 40.4, lon: -3.7 }]),
    /leg too long/,
  );
});

const osrmFixture = () => ({
  code: 'Ok',
  routes: [
    {
      distance: 12345.6,
      duration: 900.4,
      geometry: {
        type: 'LineString',
        coordinates: [
          [-0.1, 51.5],
          [-0.11, 51.51],
          ['x', 1],
          [-0.12, 51.52],
        ],
      },
      legs: [
        {
          steps: [
            {
              maneuver: { type: 'depart', location: [-0.1, 51.5] },
              name: 'Strand',
              ref: 'A4',
              distance: 100,
              duration: 20,
            },
            {
              maneuver: {
                type: 'turn',
                modifier: 'slight left',
                location: [-0.11, 51.51],
              },
              name: '',
              ref: 'A40',
              distance: 250,
              duration: 30,
            },
            {
              maneuver: { type: 'roundabout', exit: 2, location: [-0.115, 51.515] },
              name: '',
              distance: 40,
              duration: 10,
            },
            {
              maneuver: { type: 'exit roundabout', location: [-0.116, 51.516] },
              name: 'High Street',
              distance: 60,
              duration: 12,
            },
            { maneuver: { type: 'arrive', modifier: 'right', location: [-0.12, 51.52] } },
            { maneuver: { type: 'turn', location: ['bad'] } },
          ],
        },
      ],
    },
  ],
});

test('parses routes[0]: distance, duration, geometry and steps', () => {
  const r = parseRoute(osrmFixture());
  assert.equal(r.distanceM, 12346);
  assert.equal(r.durationS, 900);
  assert.deepEqual(r.coordinates, [
    [-0.1, 51.5],
    [-0.11, 51.51],
    [-0.12, 51.52],
  ]);
  assert.equal(r.stepsTruncated, false);
  assert.deepEqual(
    r.steps.map((s) => s.instruction),
    [
      'Head out on Strand (A4)',
      'Turn slightly left onto A40',
      // The exit step folds into the roundabout and lends it its road name.
      'At the roundabout, take the 2nd exit onto High Street',
      'Arrive at the destination, on the right',
    ],
  );
  assert.equal(r.steps[2].distanceM, 100);
  assert.equal(r.steps[2].durationS, 22);
  assert.deepEqual(
    r.steps.map((s) => s.index),
    [0, 1, 2, 3],
  );
});

test('no route is null with a readable reason, never a straight line', () => {
  assert.equal(parseRoute({ code: 'NoRoute', routes: [] }), null);
  assert.equal(
    routeErrorMessage({ code: 'NoRoute' }),
    'no route found between those points',
  );
  assert.equal(
    routeErrorMessage({ code: 'NoSegment' }),
    'a point is too far from any road or path',
  );
  assert.equal(routeErrorMessage(null), 'no route found');
  assert.equal(parseRoute(null), null);
  const one = osrmFixture();
  one.routes[0].geometry.coordinates = [[0, 0]];
  assert.equal(parseRoute(one), null);
});

test('instructions are plain English for every maneuver type', () => {
  const s = (type, modifier, extra = {}) => instructionFor({ type, modifier, ...extra });
  assert.equal(s('depart'), 'Head out');
  assert.equal(s('arrive'), 'Arrive at the destination');
  assert.equal(s('turn', 'uturn', { name: 'Main St' }), 'Make a U-turn onto Main St');
  assert.equal(s('turn', 'straight'), 'Continue straight');
  assert.equal(s('turn', 'sharp right'), 'Turn sharply right');
  assert.equal(s('new name', null, { name: 'B Rd' }), 'Continue onto B Rd');
  assert.equal(s('continue', 'left'), 'Continue left');
  assert.equal(s('continue', 'straight'), 'Continue straight');
  assert.equal(s('end of road', 'right'), 'At the end of the road, turn right');
  assert.equal(s('end of road'), 'At the end of the road, continue');
  assert.equal(s('fork', 'slight right'), 'Keep slightly right at the fork');
  assert.equal(s('merge', 'left'), 'Merge left');
  assert.equal(s('on ramp', 'right'), 'Take the ramp on the right');
  assert.equal(s('off ramp'), 'Take the exit');
  assert.equal(s('rotary', null, { exit: 11 }), 'At the roundabout, take the 11th exit');
  assert.equal(s('roundabout'), 'Enter the roundabout');
  assert.equal(s('roundabout turn', 'left'), 'At the roundabout, turn left');
  assert.equal(s('exit rotary'), 'Exit the roundabout');
  assert.equal(s('use lane', 'left'), 'Use the left lane');
  assert.equal(s('notification'), 'Continue');
  assert.equal(s('mystery', 'left'), 'Continue');
  assert.equal(roadLabel({ name: 'A4 Strand', ref: 'A4' }), 'A4 Strand');
  // Nothing but letters, digits, spaces and plain punctuation: safe to uppercase.
  assert.match(s('turn', 'left', { name: 'Rue X' }).toUpperCase(), /^[A-Z0-9 ,.()'-]+$/);
});

test('step lists are capped at 200 and say so', () => {
  const steps = Array.from({ length: 250 }, (_, i) => ({
    maneuver: { type: 'turn', modifier: 'left', location: [0, i / 1000] },
    distance: 1,
  }));
  const { steps: out, truncated } = normalizeSteps({ legs: [{ steps }] });
  assert.equal(out.length, ROUTE_STEPS_MAX);
  assert.equal(truncated, true);
});

test('the flown step follows distance travelled, never running off either end', () => {
  const steps = [{ distanceM: 100 }, { distanceM: 250 }, { distanceM: 0 }];
  assert.equal(stepIndexAtDistance(steps, 0), 0);
  assert.equal(stepIndexAtDistance(steps, 99), 0);
  assert.equal(stepIndexAtDistance(steps, 100), 1);
  assert.equal(stepIndexAtDistance(steps, 349), 1);
  assert.equal(stepIndexAtDistance(steps, 350), 2);
  assert.equal(stepIndexAtDistance(steps, 99999), 2);
  assert.equal(stepIndexAtDistance(steps, -5), 0);
  assert.equal(stepIndexAtDistance(steps, Number.NaN), 0);
  assert.equal(stepIndexAtDistance([], 10), null);
});

test('alongRoute walks the geometry by distance, across the antimeridian too', () => {
  const path = alongRoute([
    [0, 0],
    [0, 1],
    [1, 1],
  ]);
  assert.ok(Math.abs(path.totalM - 222_390) < 500);
  const mid = path.at(path.totalM / 4);
  assert.ok(Math.abs(mid.lat - 0.5) < 0.01 && Math.abs(mid.lon) < 1e-9);
  assert.ok(Math.abs(mid.headingDeg) < 0.01);
  const end = path.at(1e12);
  assert.deepEqual([end.lon, end.lat], [1, 1]);
  assert.ok(Math.abs(end.headingDeg - 90) < 0.1);
  const seam = alongRoute([
    [179.9, 0],
    [-179.9, 0],
  ]);
  assert.ok(seam.totalM < 30_000, 'a short hop over the seam, not around the world');
  assert.ok(Math.abs(Math.abs(seam.at(seam.totalM / 2).lon) - 180) < 1e-6);
  assert.equal(alongRoute([]).at(5), null);
  assert.ok(Math.abs(bearingDeg({ lat: 0, lon: 0 }, { lat: -1, lon: 0 }) - 180) < 1e-9);
});

test('distance and duration read tersely; attribution carries the fix-the-map link', () => {
  assert.equal(formatRouteDistance(42), '42 m');
  assert.equal(formatRouteDistance(856), '860 m');
  assert.equal(formatRouteDistance(1234), '1.2 km');
  assert.equal(formatRouteDistance(21_400), '21 km');
  assert.equal(formatRouteDistance(-1), '');
  assert.equal(formatRouteDuration(40), '40 s');
  assert.equal(formatRouteDuration(720), '12 min');
  assert.equal(formatRouteDuration(3900), '1 h 5 min');
  assert.equal(formatRouteDuration(7200), '2 h');
  assert.match(ROUTE_ATTRIBUTION, /OpenStreetMap contributors/);
  assert.equal(FIX_THE_MAP_URL, 'https://www.openstreetmap.org/fixthemap');
});
