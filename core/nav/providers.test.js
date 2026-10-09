// Parser tests against real answers saved in fixtures/ (OSRM and Valhalla on
// the FOSSGIS servers, Oct 2026, trimmed of verbose fields) and, for TomTom,
// answers built to its documented shape (no key here: not live-tested).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  osrm,
  valhalla,
  tomtom,
  providerChain,
  locateSteps,
  navMode,
  summaryFromSteps,
} from './providers.js';
import { MANEUVER_TYPES, MODIFIERS } from './maneuvers.js';
import { haversineM } from './geo.js';

const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const FROM = { lat: 37.7749, lon: -122.4194 };
const TO = { lat: 37.7599, lon: -122.4148 };

/** The contract's Route shape, checked strictly. */
function assertRoute(r, provider) {
  assert.equal(r.provider, provider);
  assert.ok(['drive', 'walk', 'bike'].includes(r.mode));
  assert.ok(r.distanceM > 0 && r.durationS > 0);
  assert.equal(typeof r.summary, 'string');
  assert.ok(r.geometry.length >= 2);
  for (const c of r.geometry) assert.ok(Number.isFinite(c[0]) && Number.isFinite(c[1]));
  assert.ok(r.steps.length >= 2);
  assert.equal(r.steps[0].maneuver.type, 'depart');
  assert.equal(r.steps.at(-1).maneuver.type, 'arrive');
  let prev = -1;
  for (const s of r.steps) {
    assert.ok(MANEUVER_TYPES.includes(s.maneuver.type), s.maneuver.type);
    if (s.maneuver.modifier) assert.ok(MODIFIERS.includes(s.maneuver.modifier));
    assert.equal(s.instruction, s.instruction.toUpperCase());
    assert.ok(Number.isInteger(s.geometryIndex) && s.geometryIndex >= prev);
    assert.ok(s.geometryIndex < r.geometry.length);
    prev = s.geometryIndex;
    // The maneuver point is on the line where geometryIndex says.
    const g = r.geometry[s.geometryIndex];
    assert.ok(haversineM(s.location[1], s.location[0], g[1], g[0]) < 30, s.instruction);
  }
}

test('navMode maps the usual words', () => {
  assert.equal(navMode('car'), 'drive');
  assert.equal(navMode('walking'), 'walk');
  assert.equal(navMode('cycling'), 'bike');
  assert.equal(navMode('boat'), null);
});

test('OSRM: request with alternatives, real answer parsed to the Route shape', () => {
  const req = osrm.request(FROM, TO, { mode: 'drive' });
  assert.equal(req.feed, 'osrm');
  assert.equal(
    req.path,
    '/routed-car/route/v1/driving/-122.4194,37.7749;-122.4148,37.7599',
  );
  assert.equal(req.params.alternatives, 'true');
  assert.equal(req.params.geometries, 'geojson');
  assert.match(
    osrm.request(FROM, TO, { mode: 'walk' }).path,
    /^\/routed-foot\/route\/v1\/foot\//,
  );
  assert.throws(() => osrm.request(FROM, { lat: 48.86, lon: 2.35 }), /too long/);

  const [r] = osrm.parse(fixture('osrm-sf-car.json'), { mode: 'drive' });
  assertRoute(r, 'osrm');
  assert.equal(r.distanceM, 1877);
  assert.equal(r.durationS, 214);
  assert.equal(r.steps[1].maneuver.type, 'turn');
  assert.equal(r.steps[1].instruction, 'SHARP RIGHT ONTO SOUTH VAN NESS AVENUE (US 101)');
  assert.equal(r.warnings, undefined);
  const [w] = osrm.parse(fixture('osrm-sf-car.json'), { avoidHighways: true });
  assert.deepEqual(w.warnings, ['HIGHWAYS NOT AVOIDED']);
  assert.deepEqual(osrm.parse({ code: 'NoRoute', routes: [] }), []);
});

test('Valhalla: pinned request; avoid-highways answer with two alternates', () => {
  const req = valhalla.request(FROM, TO, {
    mode: 'drive',
    avoidHighways: true,
    heading: 370,
  });
  assert.equal(req.feed, 'valhalla');
  assert.equal(req.path, '/route');
  const body = JSON.parse(req.params.json);
  assert.deepEqual(body.costing_options, { auto: { use_highways: 0 } });
  assert.equal(body.costing, 'auto');
  assert.equal(body.alternates, 2);
  assert.deepEqual(body.locations[0], {
    lat: 37.7749,
    lon: -122.4194,
    heading: 10,
    heading_tolerance: 45,
  });
  assert.equal(
    JSON.parse(valhalla.request(FROM, TO, { mode: 'walk' }).params.json).costing,
    'pedestrian',
  );
  assert.equal(
    JSON.parse(
      valhalla.request(FROM, TO, { mode: 'bike', avoidHighways: true }).params.json,
    ).costing_options,
    undefined,
  );

  const routes = valhalla.parse(fixture('valhalla-sf-avoid.json'), {
    avoidHighways: true,
  });
  assert.equal(routes.length, 3);
  for (const r of routes) assertRoute(r, 'valhalla');
  const [r] = routes;
  assert.equal(r.avoidHighways, true);
  assert.equal(r.distanceM, 1927);
  assert.equal(r.durationS, 214);
  assert.equal(r.steps.length, 5);
  assert.equal(r.steps[2].instruction, 'TURN LEFT ONTO 16TH STREET');
  assert.equal(r.steps[2].distanceM, 192);
  // The decoded line ends at the destination.
  const end = r.geometry.at(-1);
  assert.ok(haversineM(end[1], end[0], TO.lat, TO.lon) < 20);
  assert.ok(r.summary.includes('SOUTH VAN NESS') || r.summary.includes('South Van Ness'));
});

test('Valhalla: roundabouts fold their exits, with the exit number and road', () => {
  const [r] = valhalla.parse(fixture('valhalla-mk-roundabouts.json'));
  assertRoute(r, 'valhalla');
  const rb = r.steps.filter((s) => s.maneuver.type === 'roundabout');
  assert.equal(rb.length, 9);
  assert.equal(rb[0].maneuver.exit, 3);
  assert.equal(rb[0].name, 'H5 Portway / A509');
  assert.equal(rb[0].instruction, 'ROUNDABOUT EXIT 3 ONTO H5 PORTWAY / A509');
  assert.ok(rb[0].maneuver.modifier, 'a direction from the bearings');
  assert.ok(!r.steps.some((s) => s.instruction.startsWith('EXIT THE ROUNDABOUT')));
  // Folding keeps the distance: steps still add up to the trip.
  const sum = r.steps.reduce((t, s) => t + s.distanceM, 0);
  assert.ok(Math.abs(sum - r.distanceM) < 30, `${sum} vs ${r.distanceM}`);
});

test('Valhalla: freeway ramps and forks', () => {
  const [r] = valhalla.parse(fixture('valhalla-sf-freeway.json'));
  assertRoute(r, 'valhalla');
  const types = r.steps.map((s) => `${s.maneuver.type}/${s.maneuver.modifier ?? ''}`);
  assert.ok(types.includes('fork/slight right'));
  assert.ok(types.includes('off ramp/slight right'));
  assert.equal(
    valhalla.errorMessage({ error_code: 442 }),
    'no route found between those points',
  );
});

test('TomTom: pinned request; documented answer with traffic', () => {
  const req = tomtom.request(FROM, TO, {
    mode: 'drive',
    avoidHighways: true,
    heading: 90,
  });
  assert.equal(req.feed, 'tomtom-routing');
  assert.equal(req.path, '/calculateRoute/37.7749,-122.4194:37.7599,-122.4148/json');
  assert.deepEqual(req.params, {
    travelMode: 'car',
    traffic: 'true',
    computeTravelTimeFor: 'all',
    maxAlternatives: '2',
    instructionsType: 'text',
    language: 'en-GB',
    routeType: 'fastest',
    sectionType: 'traffic',
    avoid: 'motorways',
    vehicleHeading: 90,
  });
  assert.equal(tomtom.request(FROM, TO, { mode: 'walk' }).params.avoid, undefined);
  assert.equal(JSON.stringify(req).includes('key'), false, "the key is the proxy's");

  const routes = tomtom.parse(fixture('tomtom-route-documented.json'), { traffic: true });
  assert.equal(routes.length, 2);
  for (const r of routes) assertRoute(r, 'tomtom');
  assert.equal(routes[0].trafficDelayS, 64);
  assert.deepEqual(routes[0].traffic, [{ from: 10, to: 30, delayS: 64, kind: 'JAM' }]);
  assert.deepEqual(routes[0].warnings, ['TRAFFIC +1 MIN']);
  assert.equal(routes[1].trafficDelayS, 0);
  const plain = tomtom.parse(fixture('tomtom-route-documented.json'), { traffic: false });
  assert.equal(plain[0].trafficDelayS, undefined);
});

test('router order: TomTom with traffic, Valhalla to avoid highways, else OSRM', () => {
  assert.deepEqual(providerChain({ mode: 'drive', tomtom: true }), [
    'tomtom',
    'osrm',
    'valhalla',
  ]);
  assert.deepEqual(providerChain({ mode: 'drive', traffic: false, tomtom: true }), [
    'osrm',
    'valhalla',
  ]);
  assert.deepEqual(providerChain({ mode: 'drive', avoidHighways: true }), [
    'valhalla',
    'osrm',
  ]);
  assert.deepEqual(providerChain({ mode: 'walk', tomtom: true }), ['osrm', 'valhalla']);
});

test('locateSteps and summaries', () => {
  const line = [
    [0, 0],
    [0, 0.001],
    [0, 0.002],
    [0.001, 0.002],
  ];
  const steps = locateSteps(line, [
    { location: [0, 0], distanceM: 222 },
    { location: [0, 0.002], distanceM: 111 },
    { location: [0.001, 0.002], distanceM: 0 },
  ]);
  assert.deepEqual(
    steps.map((s) => s.geometryIndex),
    [0, 2, 3],
  );
  assert.equal(
    summaryFromSteps([
      { name: 'A', distanceM: 10 },
      { name: 'B', distanceM: 500 },
      { name: '', distanceM: 900 },
      { name: 'C', distanceM: 300 },
    ]),
    'B, C',
  );
});
