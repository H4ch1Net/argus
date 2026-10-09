import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAR_MANEUVER,
  bearingAlong,
  carDistance,
  carManeuver,
  createNavGate,
  drivingSideFor,
  formatDuration,
  indexRoute,
  locateOnRoute,
  navPayload,
  navZoom,
  pointAlong,
  routesPayload,
  searchPayload,
} from './nav.js';
import { MANEUVER_ICONS, maneuverSvg } from './maneuvers.js';
import { destination, distanceM } from './model.js';

const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b} (±${eps})`);
const T = CAR_MANEUVER;

test('turns map to the Car App Library maneuver types', () => {
  assert.deepEqual(carManeuver({ type: 'turn', modifier: 'right' }), {
    type: T.TURN_NORMAL_RIGHT,
    icon: 'turn_right',
  });
  assert.equal(
    carManeuver({ type: 'turn', modifier: 'slight left' }).type,
    T.TURN_SLIGHT_LEFT,
  );
  assert.equal(
    carManeuver({ type: 'turn', modifier: 'sharp right' }).type,
    T.TURN_SHARP_RIGHT,
  );
  assert.equal(
    carManeuver({ type: 'end of road', modifier: 'left' }).type,
    T.TURN_NORMAL_LEFT,
  );
  assert.equal(carManeuver({ type: 'continue', modifier: 'straight' }).type, T.STRAIGHT);
  assert.equal(
    carManeuver({ type: 'new name', modifier: 'straight' }).type,
    T.NAME_CHANGE,
  );
  assert.equal(
    carManeuver({ type: 'new name', modifier: 'left' }).type,
    T.TURN_NORMAL_LEFT,
  );
  assert.equal(carManeuver({ type: 'depart' }).type, T.DEPART);
});

test('a U-turn crosses the oncoming traffic', () => {
  assert.deepEqual(carManeuver({ type: 'turn', modifier: 'uturn' }), {
    type: T.U_TURN_LEFT,
    icon: 'uturn_left',
  });
  assert.equal(
    carManeuver({ type: 'turn', modifier: 'uturn' }, { side: 'left' }).type,
    T.U_TURN_RIGHT,
  );
  assert.equal(
    carManeuver({ type: 'on ramp', modifier: 'uturn' }).type,
    T.ON_RAMP_U_TURN_LEFT,
  );
});

test('ramps, forks, merges and arrivals keep their side', () => {
  assert.equal(
    carManeuver({ type: 'on ramp', modifier: 'slight right' }).type,
    T.ON_RAMP_SLIGHT_RIGHT,
  );
  assert.equal(
    carManeuver({ type: 'on ramp', modifier: 'left' }).type,
    T.ON_RAMP_NORMAL_LEFT,
  );
  assert.equal(
    carManeuver({ type: 'on ramp', modifier: 'sharp left' }).type,
    T.ON_RAMP_SHARP_LEFT,
  );
  // No side given: the ramp is on the side traffic keeps to.
  assert.equal(carManeuver({ type: 'off ramp' }).type, T.OFF_RAMP_SLIGHT_RIGHT);
  assert.equal(
    carManeuver({ type: 'off ramp' }, { side: 'left' }).type,
    T.OFF_RAMP_SLIGHT_LEFT,
  );
  assert.equal(
    carManeuver({ type: 'off ramp', modifier: 'sharp right' }).type,
    T.OFF_RAMP_NORMAL_RIGHT,
  );
  assert.equal(carManeuver({ type: 'fork', modifier: 'slight left' }).icon, 'fork_left');
  assert.equal(carManeuver({ type: 'fork', modifier: 'right' }).type, T.FORK_RIGHT);
  assert.equal(
    carManeuver({ type: 'use lane', modifier: 'slight right' }).type,
    T.KEEP_RIGHT,
  );
  assert.equal(
    carManeuver({ type: 'merge', modifier: 'slight left' }).type,
    T.MERGE_LEFT,
  );
  assert.equal(carManeuver({ type: 'merge' }).type, T.MERGE_SIDE_UNSPECIFIED);
  assert.equal(
    carManeuver({ type: 'arrive', modifier: 'right' }).type,
    T.DESTINATION_RIGHT,
  );
  assert.equal(
    carManeuver({ type: 'arrive', modifier: 'straight' }).type,
    T.DESTINATION_STRAIGHT,
  );
  assert.equal(carManeuver({ type: 'arrive' }).type, T.DESTINATION);
});

test('roundabouts circulate with the traffic and carry their exit', () => {
  assert.deepEqual(carManeuver({ type: 'roundabout', modifier: 'right', exit: 2 }), {
    type: T.ROUNDABOUT_ENTER_AND_EXIT_CCW,
    icon: 'roundabout_ccw',
    exitNumber: 2,
  });
  assert.deepEqual(carManeuver({ type: 'rotary', exit: 3 }, { side: 'left' }), {
    type: T.ROUNDABOUT_ENTER_AND_EXIT_CW,
    icon: 'roundabout_cw',
    exitNumber: 3,
  });
  // Without an exit number the ENTER_AND_EXIT types would be refused.
  assert.equal(carManeuver({ type: 'roundabout' }).type, T.ROUNDABOUT_ENTER_CCW);
  assert.equal(carManeuver({ type: 'roundabout', exit: 0 }).type, T.ROUNDABOUT_ENTER_CCW);
  assert.equal(
    carManeuver({ type: 'exit roundabout' }, { side: 'left' }).type,
    T.ROUNDABOUT_EXIT_CW,
  );
});

test('unknown maneuvers fall back without throwing', () => {
  assert.deepEqual(carManeuver({ type: 'teleport' }), {
    type: T.UNKNOWN,
    icon: 'straight',
  });
  assert.equal(
    carManeuver({ type: 'notification', modifier: 'left' }).type,
    T.TURN_NORMAL_LEFT,
  );
  assert.equal(carManeuver(null).type, T.UNKNOWN);
});

test('every maneuver type is a real Car App Library type with a glyph', () => {
  const types = [
    'turn',
    'new name',
    'depart',
    'arrive',
    'merge',
    'on ramp',
    'off ramp',
    'fork',
    'end of road',
    'continue',
    'roundabout',
    'rotary',
    'exit roundabout',
    'use lane',
    'unknown',
  ];
  const mods = [
    undefined,
    'uturn',
    'sharp right',
    'right',
    'slight right',
    'straight',
    'slight left',
    'left',
    'sharp left',
  ];
  const valid = new Set(Object.values(T));
  for (const side of ['left', 'right'])
    for (const type of types)
      for (const modifier of mods)
        for (const exit of [undefined, 2]) {
          const m = carManeuver({ type, modifier, exit }, { side });
          assert.ok(valid.has(m.type), `${type}/${modifier}: ${m.type}`);
          assert.ok(MANEUVER_ICONS[m.icon], `${type}/${modifier}: no glyph ${m.icon}`);
        }
  for (const name of Object.keys(MANEUVER_ICONS))
    assert.match(maneuverSvg(name), /^<svg .*<\/svg>$/);
});

test('driving side comes from the region', () => {
  assert.equal(drivingSideFor('en-GB'), 'left');
  assert.equal(drivingSideFor('ja_JP'), 'left');
  assert.equal(drivingSideFor('en-US'), 'right');
  assert.equal(drivingSideFor('de'), 'right');
});

test('carDistance rounds like a navigation app', () => {
  assert.deepEqual(carDistance(83), { value: 80, unit: 'm' });
  assert.deepEqual(carDistance(437), { value: 450, unit: 'm' });
  assert.deepEqual(carDistance(990), { value: 1, unit: 'km_p1' });
  assert.deepEqual(carDistance(1234), { value: 1.2, unit: 'km_p1' });
  assert.deepEqual(carDistance(12_600), { value: 13, unit: 'km' });
  assert.deepEqual(carDistance(100, 'imperial'), { value: 350, unit: 'ft' });
  assert.deepEqual(carDistance(1609.344 * 2.34, 'imperial'), {
    value: 2.3,
    unit: 'mi_p1',
  });
  assert.deepEqual(carDistance(1609.344 * 25.6, 'imperial'), { value: 26, unit: 'mi' });
  assert.deepEqual(carDistance(NaN), { value: 0, unit: 'm' });
  assert.equal(formatDuration(65), '1 MIN');
  assert.equal(formatDuration(18 * 60 + 10), '18 MIN');
  assert.equal(formatDuration(3900), '1 H 05');
});

test('search and route payloads are bounded and carry display distances', () => {
  const here = { lat: 37.77, lon: -122.42 };
  const places = Array.from({ length: 12 }, (_, i) => ({
    id: `p${i}`,
    name: `Place ${i}`,
    detail: 'San Francisco',
    kind: 'poi',
    lat: 37.77 + i * 0.01,
    lon: -122.42,
  }));
  places.splice(3, 0, { id: 'bad', name: 'No position' });
  const s = searchPayload(places, here, 'metric');
  assert.equal(s.results.length, 8);
  assert.equal(s.results[0].distanceM, 0);
  assert.equal(s.results[1].distance.unit, 'km_p1');
  assert.ok(!s.results.some((r) => r.id === 'bad'));
  const r = routesPayload(
    [1, 2, 3, 4].map((i) => ({
      id: `r${i}`,
      distanceM: 1000 * i,
      durationS: 60 * i,
      geometry: [[0, 0]],
    })),
    'metric',
    'q7',
  );
  assert.equal(r.reqId, 'q7');
  assert.equal(r.routes.length, 3);
  assert.equal(r.routes[0].geometry, undefined);
  assert.deepEqual(r.routes[2].distance, { value: 3, unit: 'km_p1' });
});

function navState(over = {}) {
  const step = {
    maneuver: { type: 'turn', modifier: 'right' },
    instruction: 'Turn right onto Market Street',
    name: 'Market Street',
    distanceM: 800,
    durationS: 80,
    location: [-122.41, 37.78],
    geometryIndex: 4,
  };
  return {
    status: 'navigating',
    destination: { name: 'Ferry Building', detail: 'San Francisco' },
    route: { id: 'r1', trafficDelayS: 120, geometry: [], steps: [step] },
    progress: {
      distanceRemainingM: 5200,
      durationRemainingS: 720,
      eta: Date.UTC(2026, 9, 9, 14, 32),
      stepIndex: 1,
      distanceToStepM: 400,
      step,
      then: {
        ...step,
        maneuver: { type: 'arrive', modifier: 'left' },
        instruction: 'Arrive',
        name: '',
      },
      offRoute: false,
      snapped: { lat: 37.77, lon: -122.42 },
    },
    ...over,
  };
}

test('navPayload carries the contract fields and what the card shows', () => {
  const p = navPayload(navState(), { units: 'metric' });
  assert.equal(p.status, 'navigating');
  assert.equal(p.instruction, 'Turn right onto Market Street');
  assert.equal(p.roadName, 'Market Street');
  assert.equal(p.distanceToStepM, 400);
  assert.deepEqual(p.stepDistance, { value: 400, unit: 'm' });
  assert.equal(p.maneuver.type, T.TURN_NORMAL_RIGHT);
  assert.equal(p.maneuver.icon, 'turn_right');
  assert.equal(p.then.maneuver.type, T.DESTINATION_LEFT);
  assert.equal(p.timeToStepS, 40); // half the step left: half its 80 s
  assert.equal(p.distanceRemainingM, 5200);
  assert.equal(p.durationRemainingS, 720);
  assert.equal(p.eta, Date.UTC(2026, 9, 9, 14, 32));
  assert.equal(p.destination.name, 'Ferry Building');
  assert.equal(p.currentRoad, 'Market Street'); // the road step 0 turned onto
  const first = navState();
  first.progress.stepIndex = 0;
  assert.equal(navPayload(first).currentRoad, '');
  const idle = navPayload({ status: 'idle' });
  assert.deepEqual(idle, { status: 'idle', routeId: null, destination: null });
  assert.equal(navPayload(navState({ status: 'rerouting' })).status, 'rerouting');
});

test('nav updates go at most once a second, steps and status at once', () => {
  const gate = createNavGate();
  const a = navPayload(navState());
  assert.equal(gate.decide(a, 0), 'send');
  gate.sent(a, 0);
  // Same picture: nothing to send.
  assert.equal(gate.decide(navPayload(navState()), 300), 'skip');
  // The distance moved on: wait for the second.
  const closer = navState();
  closer.progress.distanceToStepM = 340;
  const b = navPayload(closer);
  assert.equal(gate.decide(b, 300), 'later');
  assert.equal(gate.wait(300), 700);
  assert.equal(gate.decide(b, 1000), 'send');
  gate.sent(b, 1000);
  // A new step goes at once.
  const next = navState();
  next.progress.stepIndex = 2;
  assert.equal(gate.decide(navPayload(next), 1100), 'send');
  // So does a change of status.
  assert.equal(gate.decide(navPayload(navState({ status: 'rerouting' })), 1100), 'send');
  gate.reset();
  assert.equal(gate.decide(b, 1100), 'send');
});

test('a route is indexed, located and walked along', () => {
  // A 2 km run north, then 1 km east.
  const a = { lat: 37.7, lon: -122.4 };
  const b = destination(a.lat, a.lon, 0, 2000);
  const c = destination(b.lat, b.lon, 90, 1000);
  const mid = (p, q) => ({ lat: (p.lat + q.lat) / 2, lon: (p.lon + q.lon) / 2 });
  const pts = [a, mid(a, b), b, mid(b, c), c];
  const ix = indexRoute(pts.map((p) => [p.lon, p.lat]));
  near(ix.total, 3000, 2);
  // 10 m east of the route, 500 m up the first leg.
  const p = destination(...Object.values(destination(a.lat, a.lon, 0, 500)), 90, 10);
  const at = locateOnRoute(ix, p.lat, p.lon, 0);
  assert.equal(at.index, 0);
  near(at.along, 500, 2);
  near(at.off, 10, 0.5);
  near(
    distanceM(at.lat, at.lon, ...Object.values(destination(a.lat, a.lon, 0, 500))),
    0,
    1,
  );
  // A bad hint still finds the vehicle on the second leg.
  const q = destination(b.lat, b.lon, 90, 700);
  const at2 = locateOnRoute(ix, q.lat, q.lon, 0);
  assert.equal(at2.index, 3);
  near(at2.along, 2700, 3);
  // Walk along.
  const w = pointAlong(ix, 2500);
  near(
    distanceM(w.lat, w.lon, ...Object.values(destination(b.lat, b.lon, 90, 500))),
    0,
    2,
  );
  assert.deepEqual(pointAlong(ix, -5), { lat: a.lat, lon: a.lon, index: 0 });
  near(pointAlong(ix, 9e9).lat, c.lat, 1e-9);
  near(bearingAlong(ix, 100), 0, 0.5);
  near(bearingAlong(ix, 2100), 90, 0.5);
  assert.equal(locateOnRoute(indexRoute([[0, 0]]), 0, 0), null);
});

test('navigating zooms in, more so on the approach to a turn', () => {
  assert.equal(navZoom(1200, 15), 0.55);
  assert.equal(navZoom(200, 15), 0.38);
  // At motorway speed the view stays wide for the exit.
  assert.equal(navZoom(200, 30), 0.55);
  assert.equal(navZoom(NaN, 0), 0.55);
});
