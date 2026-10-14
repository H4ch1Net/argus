import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRoute,
  lineRoutes,
  routeMatch,
  routeLabel,
  foldStreet,
  foldRoutes,
  nameMatch,
  roadQuery,
  roadMatch,
  looksLikeRoad,
} from './roads.js';

const route = (type, num, qual = null) => ({ type, num, qual });

test('every way of writing a state highway names the same route', () => {
  for (const t of [
    'Highway 111',
    'Hwy 111',
    'Route 111',
    'Rte 111',
    'State Route 111',
    'State Highway 111',
    'SR 111',
    'SR-111',
    'CA 111',
    'CA-111',
    'CA- 111', // OSM's name on the Indio stretch
    'ca111',
  ]) {
    const r = parseRoute(t);
    assert.ok(r, t);
    assert.equal(r.num, '111', t);
    assert.ok(routeMatch(parseRoute('Highway 111'), r) > 0, t);
    assert.equal(foldRoutes(foldStreet(t)).join(' '), 'rt111', t);
  }
  assert.deepEqual(parseRoute('Highway 111'), route('*', '111'));
  assert.deepEqual(parseRoute('CA 111'), route('SR', '111'));
});

test('interstates and US highways', () => {
  for (const t of ['I-10', 'I 10', 'Interstate 10', 'i10', 'IH 10'])
    assert.deepEqual(parseRoute(t), route('I', '10'), t);
  for (const t of ['US 99', 'US-99', 'U.S. 99', 'US Highway 99', 'US Route 99'])
    assert.deepEqual(parseRoute(t), route('US', '99'), t);
  // Not routes: a name that only contains one, a ZIP, a plain street.
  assert.equal(parseRoute('Highway 111 Bridge'), null);
  assert.equal(parseRoute('CA 92201'), null);
  assert.equal(parseRoute('Jackson Street'), null);
  assert.equal(parseRoute('Avenue 44'), null);
  // "ne 5th" is not Nebraska 5: codes that are words are not prefixes.
  assert.equal(parseRoute('NE 5'), null);
});

test("a line's refs and names as the tiles carry them (Indio, Oct 2026)", () => {
  // Interstate 10: ref "10" in the us-interstate network.
  assert.deepEqual(lineRoutes({ ref: '10', network: 'us-interstate' }), [
    route('I', '10'),
  ]);
  // Indio Boulevard: three routes, two of them variants.
  assert.deepEqual(
    lineRoutes({ ref: 'CA 111 Old;I 10 BUS;US 99 Hist', network: 'road' }),
    [route('SR', '111', 'old'), route('I', '10', 'bus'), route('US', '99', 'old')],
  );
  assert.deepEqual(lineRoutes({ names: ['CA- 111'] }), [route('SR', '111')]);
  // Highway 111 is the old alignment there: a variant, still a match.
  assert.equal(routeMatch(parseRoute('Highway 111'), route('SR', '111', 'old')), 0.7);
  assert.equal(routeMatch(parseRoute('I-10'), route('I', '10')), 1);
  assert.equal(routeMatch(parseRoute('I-10'), route('US', '10')), 0);
  assert.equal(routeMatch(parseRoute('I-10'), route('I', '110')), 0);
});

test('route labels read like signs', () => {
  assert.equal(routeLabel(parseRoute('hwy 111'), 'hwy 111'), 'Highway 111');
  assert.equal(routeLabel(parseRoute('interstate 10'), 'interstate 10'), 'I-10');
  assert.equal(routeLabel(parseRoute('ca-111'), 'ca-111'), 'CA 111');
  assert.equal(routeLabel(route('I', '10', 'bus')), 'I-10 Business');
});

test('street words: every spelling folds to one', () => {
  assert.deepEqual(foldStreet('Golf Center pkway'), ['golf', 'center', 'pkwy']);
  for (const t of ['Golf Center Parkway', 'Golf Center Pkwy', 'golf center pky'])
    assert.deepEqual(foldStreet(t), ['golf', 'center', 'pkwy'], t);
  assert.deepEqual(foldStreet('Indio Boulevard'), foldStreet('INDIO BLVD'));
  assert.deepEqual(foldStreet('Jackson Street'), foldStreet('jackson st'));
  assert.deepEqual(foldStreet('Monroe Drive'), foldStreet('Monroe Dr'));
  assert.deepEqual(foldStreet('Avenue 44'), ['ave', '44']);
  assert.deepEqual(foldStreet('Main Road'), foldStreet('main rd'));
  assert.deepEqual(foldStreet('Elm Lane'), foldStreet('elm ln'));
  assert.deepEqual(foldStreet('Oak Court'), foldStreet('oak ct'));
  assert.deepEqual(foldStreet('Sonny Bono Memorial Freeway'), [
    'sonny',
    'bono',
    'memorial',
    'fwy',
  ]);
  assert.deepEqual(foldStreet('Central Expressway'), ['central', 'expy']);
  assert.deepEqual(foldStreet('North Jackson Street'), ['n', 'jackson', 'st']);
});

test('names match as typed, near enough, or not at all', () => {
  const m = (q, n, o) => nameMatch(foldStreet(q), foldStreet(n), o);
  assert.equal(m('Golf Center pkway', 'Golf Center Parkway'), 1);
  assert.equal(m('Jackson St', 'North Jackson Street'), 1); // directions aside
  assert.equal(m('Monroe', 'Monroe Street'), 0.7); // no street word typed
  assert.equal(m('Avenue 44', '44th Avenue'), 0.7); // the words in another order
  assert.equal(m('Golf Center Dr', 'Golf Center Parkway'), 0.7); // another street word
  assert.equal(m('Jackson St', 'Jefferson Street'), 0);
  assert.equal(m('Monroe St', 'Monroe Street Park'), 0);
  // Half typed (the end of a query).
  assert.equal(m('golf center pk', 'Golf Center Parkway', { partial: true }), 0.95);
  assert.equal(m('golf cen', 'Golf Center Parkway', { partial: true }), 0.8);
  assert.equal(m('golf cen', 'Golf Center Parkway'), 0);
});

test('a typed side against a road line (names and refs)', () => {
  const golf = { names: ['Golf Center Parkway'], routes: [] };
  const hwy = {
    names: ['46th Avenue'],
    routes: lineRoutes({ ref: 'CA 111 Old', network: 'road' }),
  };
  const i10 = {
    names: ['Sonny Bono Memorial Freeway'],
    routes: lineRoutes({ ref: '10', network: 'us-interstate' }),
  };
  assert.equal(roadMatch(roadQuery('Golf Center pkway'), golf), 1);
  assert.equal(roadMatch(roadQuery('Highway 111'), hwy), 0.7);
  assert.equal(roadMatch(roadQuery('46th Ave'), hwy), 1);
  assert.equal(roadMatch(roadQuery('Interstate 10'), i10), 1);
  assert.equal(roadMatch(roadQuery('I 10'), hwy), 0);
  assert.equal(roadMatch(roadQuery('Highway 111'), golf), 0);
});

test('what reads as a street', () => {
  for (const t of [
    'Highway 111',
    'Golf Center pkway',
    'Jackson St',
    'Indio Blvd',
    'Avenue 44',
    'I-10',
  ])
    assert.equal(looksLikeRoad(t), true, t);
  for (const t of ['Monroe', 'Lord', 'Taylor', 'Bed Bath', 'Beyond', 'Starbucks'])
    assert.equal(looksLikeRoad(t), false, t);
});
