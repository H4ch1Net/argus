import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGeoIntent,
  planGeoIntent,
  answerGeoAction,
  AUTO_START_M,
} from './geoIntent.js';

test("Google's navigation intent examples read as Google describes them", () => {
  const a = parseGeoIntent('geo:0,0?q=Googleplex');
  assert.equal(a.kind, 'navigate');
  assert.equal(a.query, 'Googleplex');
  assert.equal(a.dest, null);
  assert.equal(a.near, null);
  assert.equal(a.intent, 'navigation');

  const b = parseGeoIntent(
    'geo:0,0?q=1600+Amphitheatre+parkway&mode=b&intent=add_a_stop',
  );
  assert.equal(b.query, '1600 Amphitheatre parkway');
  assert.equal(b.mode, 'b');
  assert.equal(b.intent, 'add_a_stop');

  const c = parseGeoIntent(
    'geo:1.1,2.2?q=Starbucks+on+Main+Street&mode=w&intent=navigation',
  );
  assert.equal(c.query, 'Starbucks on Main Street');
  assert.deepEqual(c.near, { lat: 1.1, lon: 2.2 });

  const d = parseGeoIntent('geo:1.1,2.2?mode=w&intent=navigation');
  assert.deepEqual(d.dest, { lat: 1.1, lon: 2.2, name: '' });
  assert.equal(d.query, '');

  const e = parseGeoIntent('geo:0,0?q=googleplex&avoid=tf');
  assert.deepEqual(e.avoid, { highways: false, tolls: true, ferries: true });

  const f = parseGeoIntent(
    'geo:47.61594547836694,-122.20373173098756?q=575+Bellevue+Square,+Bellevue,+WA+98004&intent=add_a_stop',
  );
  assert.equal(f.query, '575 Bellevue Square, Bellevue, WA 98004');
  assert.equal(f.intent, 'add_a_stop');

  // The Car App Library's own forms (CarContext.startCarApp).
  assert.deepEqual(parseGeoIntent('geo:12.345,14.8767').dest, {
    lat: 12.345,
    lon: 14.8767,
    name: '',
  });
  assert.equal(
    parseGeoIntent('geo:0,0?q=123+Main+St,+Seattle,+WA+98101').query,
    '123 Main St, Seattle, WA 98101',
  );
});

test('a search intent, a named point, percent escapes and RFC 5870 extras', () => {
  const s = parseGeoIntent('geo:0,0?q=restaurants+nearby', 'search');
  assert.equal(s.kind, 'search');
  assert.equal(s.query, 'restaurants nearby');

  const p = parseGeoIntent('geo:0,0?q=33.7211,-116.1940(Casino%20%26%20Hotel)');
  assert.deepEqual(p.dest, { lat: 33.7211, lon: -116.194, name: 'Casino & Hotel' });

  assert.deepEqual(parseGeoIntent('geo:33.72,-116.19;u=35').dest, {
    lat: 33.72,
    lon: -116.19,
    name: '',
  });
  assert.equal(parseGeoIntent('GEO:0,0?Q=Indio').query, 'Indio');
  // geo.offline is the same request.
  assert.equal(parseGeoIntent('geo.offline:0,0?q=Indio').query, 'Indio');
  // A broken escape keeps the text.
  assert.equal(parseGeoIntent('geo:0,0?q=50%+off').query, '50% off');
});

test('nothing to go to, or not a geo URI at all, is null', () => {
  assert.equal(parseGeoIntent('geo:0,0'), null);
  assert.equal(parseGeoIntent('geo:0,0?q='), null);
  assert.equal(parseGeoIntent('geo:91,0'), null);
  assert.equal(parseGeoIntent('https://example.com/?q=x'), null);
  assert.equal(parseGeoIntent(''), null);
  assert.equal(parseGeoIntent(null), null);
  assert.equal(parseGeoIntent('geo.action:?act='), null);
  // Control characters go; the text is capped.
  assert.equal(parseGeoIntent('geo:0,0?q=a%0Ab').query, 'a b');
  assert.equal(parseGeoIntent(`geo:0,0?q=${'x'.repeat(500)}`).query.length, 200);
});

test('custom actions read their act and parameters', () => {
  const a = parseGeoIntent('geo.action:?act=report_crash&accident_type=major');
  assert.equal(a.kind, 'action');
  assert.equal(a.act, 'report_crash');
  assert.equal(a.params.accident_type, 'major');
  assert.equal(parseGeoIntent('geo.action:?act=exit_navigation').act, 'exit_navigation');
});

test('a voice "navigate to" starts at once on one match or a close best match', () => {
  const req = parseGeoIntent('geo:0,0?q=walmart');
  const near = { name: 'Walmart', lat: 33.7, lon: -116.2, distanceM: 4000 };
  const far = { name: 'Walmart', lat: 34.1, lon: -117.3, distanceM: AUTO_START_M + 1 };
  assert.deepEqual(planGeoIntent(req, [near, far]), {
    kind: 'route',
    place: near,
    autoStart: true,
  });
  // The best match far away, a same-named one close: the close one.
  assert.equal(planGeoIntent(req, [far, near]).place, near);
  // The best match far away, others not so named: the driver picks.
  const super_ = { ...near, name: 'Walmart Supercenter' };
  const list = planGeoIntent(req, [far, super_]);
  assert.equal(list.kind, 'list');
  assert.equal(list.results.length, 2);
  // The best match far, the very name asked for close by: that one.
  const depot = planGeoIntent(parseGeoIntent('geo:0,0?q=Home+Depot'), [
    { name: 'Home Depot Power Center', lat: 33.1, lon: -117.1, distanceM: 107_000 },
    { name: 'The Home Depot', lat: 33.74, lon: -116.21, distanceM: 3100 },
  ]);
  assert.equal(depot.kind, 'route');
  assert.equal(depot.place.name, 'The Home Depot');
  // Close by but not the name asked for: the driver picks.
  const la = planGeoIntent(parseGeoIntent('geo:0,0?q=Los+Angeles'), [
    { name: 'Los Angeles', lat: 34.05, lon: -118.24, distanceM: 191_000 },
    { name: 'Los Angeles Mine', lat: 33.9, lon: -116.5, distanceM: 60_000 },
  ]);
  assert.equal(la.kind, 'list');
  // One match, however far: that is where to go.
  assert.equal(planGeoIntent(req, [far]).autoStart, true);
  // No position (no distance): the best match.
  assert.equal(planGeoIntent(req, [{ name: 'X', lat: 1, lon: 2 }]).autoStart, true);
  assert.deepEqual(planGeoIntent(req, []), {
    kind: 'message',
    message: 'NO PLACES FOUND: WALMART',
  });
});

test('directions and add a stop show the route without starting it; search lists', () => {
  const place = { name: 'Pier 57', lat: 47.6, lon: -122.3, distanceM: 1000 };
  const dir = planGeoIntent(parseGeoIntent('geo:0,0?q=pier+57&intent=directions'), [
    place,
  ]);
  assert.equal(dir.kind, 'route');
  assert.equal(dir.autoStart, false);
  const stop = planGeoIntent(parseGeoIntent('geo:0,0?q=pier+57&intent=add_a_stop'), [
    place,
  ]);
  assert.equal(stop.autoStart, false);
  assert.match(stop.note, /NO STOPS/);
  const list = planGeoIntent(parseGeoIntent('geo:0,0?q=coffee', 'search'), [place]);
  assert.deepEqual(list, { kind: 'list', query: 'coffee', results: [place] });
});

test('a point is a route to it, named when the request names it', () => {
  const plan = planGeoIntent(parseGeoIntent('geo:33.72115,-116.19399'));
  assert.equal(plan.kind, 'route');
  assert.equal(plan.autoStart, true);
  assert.equal(plan.place.name, '33.7212, -116.1940');
  assert.equal(plan.place.kind, 'pin');
  const named = planGeoIntent(parseGeoIntent('geo:0,0?q=33.72,-116.19(Home)'));
  assert.equal(named.place.name, 'Home');
  assert.equal(named.place.detail, '33.7200, -116.1900');
});

test('every custom action gets an answer; those Argus cannot do say so', () => {
  const nav = {
    status: 'navigating',
    eta: Date.UTC(2026, 9, 16, 18, 42),
    durationRemainingS: 1080,
    distanceRemainingM: 20000,
    distanceToStepM: 320,
    timeToStepS: 25,
    instruction: 'Turn right onto Jackson St',
    currentRoad: 'Avenue 44',
    destination: { name: 'Casino' },
  };
  const opts = { nav, units: 'imperial', clock: () => '18:42' };
  assert.deepEqual(answerGeoAction('exit_navigation', opts), {
    act: 'exit_navigation',
    message: 'NAVIGATION ENDED',
    stop: true,
  });
  assert.equal(answerGeoAction('exit_navigation').message, 'NOT NAVIGATING');
  assert.equal(answerGeoAction('eta', opts).message, 'ARRIVE 18:42 · 18 MIN');
  assert.equal(answerGeoAction('distance_to_destination', opts).message, '12 MI TO GO');
  assert.equal(
    answerGeoAction('distance_to_next_turn', opts).message,
    'TURN RIGHT ONTO JACKSON ST IN 0.2 MI',
  );
  assert.equal(
    answerGeoAction('time_to_next_turn', opts).message,
    'TURN RIGHT ONTO JACKSON ST IN 25 S',
  );
  assert.equal(answerGeoAction('query_destination', opts).message, 'TO CASINO');
  assert.equal(answerGeoAction('query_current_road', opts).message, 'ON AVENUE 44');
  assert.equal(answerGeoAction('route_overview', opts).overview, true);
  assert.equal(answerGeoAction('follow_mode').follow, true);
  assert.deepEqual(answerGeoAction('show_traffic', { trafficAvailable: true }), {
    act: 'show_traffic',
    message: 'TRAFFIC FLOW ON',
    layer: 'trafficflow',
    on: true,
  });
  assert.match(answerGeoAction('show_traffic').message, /TOMTOM KEY/);
  assert.equal(answerGeoAction('avoid_highways').avoidHighways, true);
  assert.equal(answerGeoAction('allow_highways').avoidHighways, false);
  assert.equal(answerGeoAction('avoid_tolls').message, 'ARGUS CAN ONLY AVOID HIGHWAYS');
  assert.equal(answerGeoAction('mute').message, 'ARGUS HAS NO VOICE GUIDANCE');
  assert.equal(answerGeoAction('report_police').message, 'REPORTS ARE NOT IN ARGUS');
  assert.equal(answerGeoAction('show_alternates').message, 'NOT IN ARGUS');
  assert.equal(answerGeoAction('eta').message, 'NOT NAVIGATING');
});
