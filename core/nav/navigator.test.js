// The navigation contract end to end, over a fake proxy client that answers
// with the real router fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createNavigator, planErrorMessage, routeCost } from './navigator.js';
import { createDriveSim } from './simulate.js';
import { destination } from './geo.js';

const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const FROM = { lat: 37.7749, lon: -122.4194 };
const TO = {
  id: 'osm:x',
  name: 'Folsom St',
  detail: 'SF',
  lat: 37.7599,
  lon: -122.4148,
  kind: 'place',
};

function fakeProxy(answers = {}) {
  const calls = [];
  return {
    calls,
    getJson: async (feed, path, opts = {}) => {
      calls.push({ feed, path, params: opts.params });
      const a = answers[feed];
      if (a === undefined) throw Object.assign(new Error(`no ${feed}`), { status: 502 });
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(path, opts.params) : a;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test('plan: OSRM first, routes ranked with the signal wait, previewing', async () => {
  const proxy = fakeProxy({
    osrm: fixture('osrm-sf-car.json'),
    overpass: fixture('overpass-sf-signals.json'),
  });
  const nav = createNavigator({ proxyClient: proxy, hasFeed: () => false });
  const seen = [];
  nav.subscribe((s) => seen.push(s.status));
  const routes = await nav.plan(FROM, TO, { mode: 'drive' });
  assert.equal(routes.length, 1);
  assert.equal(routes[0].provider, 'osrm');
  assert.match(routes[0].id, /^r\d+$/);
  assert.equal(routes[0].signals, 9);
  assert.equal(routeCost(routes[0]), routes[0].durationS + routes[0].signalDelayS);
  assert.deepEqual(seen, ['planning', 'previewing']);
  assert.equal(nav.state.status, 'previewing');
  assert.equal(nav.state.route, routes[0]);
  assert.deepEqual(nav.state.destination, TO);
  assert.equal(Object.isFrozen(nav.state), true);
  assert.deepEqual(
    proxy.calls.map((c) => c.feed),
    ['osrm', 'overpass'],
  );
});

test('avoid highways goes to Valhalla; a failing router falls back to the next', async () => {
  const proxy = fakeProxy({
    valhalla: (path, params) => {
      assert.deepEqual(JSON.parse(params.json).costing_options, {
        auto: { use_highways: 0 },
      });
      return fixture('valhalla-sf-avoid.json');
    },
    overpass: fixture('overpass-sf-signals.json'),
  });
  const nav = createNavigator({ proxyClient: proxy, hasFeed: () => false });
  const routes = await nav.plan(FROM, TO, { avoidHighways: true });
  assert.equal(routes.length, 3);
  assert.ok(routes.every((r) => r.provider === 'valhalla' && r.avoidHighways));
  for (let i = 1; i < routes.length; i += 1)
    assert.ok(routeCost(routes[i]) >= routeCost(routes[i - 1]), 'best first');

  // OSRM down: Valhalla answers instead.
  const p2 = fakeProxy({ valhalla: fixture('valhalla-sf-avoid.json') });
  const n2 = createNavigator({ proxyClient: p2, hasFeed: () => false, signals: false });
  const r2 = await n2.plan(FROM, TO, { mode: 'walk' });
  assert.equal(r2[0].provider, 'valhalla');
  assert.deepEqual(
    p2.calls.map((c) => c.feed),
    ['osrm', 'valhalla'],
  );
});

test('TomTom with traffic when the proxy has the key; learnt when it has not', async () => {
  const proxy = fakeProxy({
    'tomtom-routing': fixture('tomtom-route-documented.json'),
    overpass: fixture('overpass-sf-signals.json'),
  });
  const nav = createNavigator({
    proxyClient: proxy,
    hasFeed: (id) => id === 'tomtom-routing',
  });
  assert.equal(nav.traffic, true);
  const routes = await nav.plan(FROM, TO, { traffic: true });
  assert.equal(routes[0].provider, 'tomtom');
  assert.equal(routes[0].trafficDelayS, 64);
  assert.equal(routes[0].signalDelayS, 0);

  // No hasFeed: TomTom is tried once, then dropped for the session.
  const p2 = fakeProxy({ osrm: fixture('osrm-sf-car.json') });
  const n2 = createNavigator({ proxyClient: p2, signals: false });
  await n2.plan(FROM, TO);
  await n2.plan(FROM, TO);
  assert.deepEqual(
    p2.calls.map((c) => c.feed),
    ['tomtom-routing', 'osrm', 'osrm'],
  );
  assert.equal(n2.traffic, false);
});

test('a failed plan goes back to idle with a ctOS reason', async () => {
  const nav = createNavigator({
    proxyClient: fakeProxy({
      osrm: Object.assign(new Error('400'), { status: 400 }),
      valhalla: Object.assign(new Error('400'), { status: 400 }),
    }),
    hasFeed: () => false,
  });
  await assert.rejects(nav.plan(FROM, TO));
  assert.equal(nav.state.status, 'idle');
  assert.equal(nav.state.error, 'NO ROUTE BETWEEN THESE POINTS');
  await assert.rejects(nav.plan(FROM, { lat: 48.86, lon: 2.35 }), /too long/);
  assert.match(nav.state.error, /TOO LONG/);
  const off = createNavigator({ proxyClient: null });
  await assert.rejects(off.plan(FROM, TO));
  assert.equal(off.state.error, 'ROUTING NEEDS THE PROXY');
  assert.equal(planErrorMessage({ status: 429 }), 'ROUTER BUSY: TRY AGAIN SHORTLY');
});

test('navigate: progress per fix, reroute when off route, then arrival', async () => {
  let t = 5_000_000;
  const osrmAnswers = [fixture('osrm-sf-car.json'), fixture('osrm-sf-car.json')];
  const proxy = fakeProxy({
    osrm: () => osrmAnswers.shift() ?? fixture('osrm-sf-car.json'),
    overpass: fixture('overpass-sf-signals.json'),
  });
  const nav = createNavigator({ proxyClient: proxy, hasFeed: () => false, now: () => t });
  const [route] = await nav.plan(FROM, TO);
  nav.start(route);
  assert.equal(nav.state.status, 'navigating');
  assert.equal(nav.state.progress.stepIndex, 1);
  const sim = createDriveSim(route);
  nav.update({ ...sim.fixAt(20, t), t });
  const p = nav.state.progress;
  assert.ok(p.distanceRemainingM < route.distanceM);
  assert.equal(p.eta, t + p.durationRemainingS * 1000);
  assert.equal(typeof p.step.instruction, 'string');

  // Three fixes 80 m off the line: a reroute from there.
  const on = sim.fixAt(20, t);
  const side = destination(on.lat, on.lon, (on.heading + 90) % 360, 80);
  const osrmCalls = () => proxy.calls.filter((c) => c.feed === 'osrm').length;
  const before = osrmCalls();
  for (let i = 0; i < 3; i += 1) {
    t += 1000;
    nav.update({ ...side, heading: on.heading, speed: 10, accuracy: 5, t });
  }
  assert.equal(nav.state.status, 'rerouting');
  assert.equal(nav.state.progress.offRoute, true);
  await flush();
  await flush();
  await flush();
  assert.equal(osrmCalls(), before + 1);
  const reroute = proxy.calls.filter((c) => c.feed === 'osrm').at(-1);
  assert.ok(
    reroute.path.includes(
      `${Number(side.lon.toFixed(6))},${Number(side.lat.toFixed(6))};`,
    ),
  );
  assert.equal(nav.state.status, 'navigating');
  assert.notEqual(nav.state.route.id, route.id);
  // No second reroute inside 10 s.
  for (let i = 0; i < 3; i += 1) nav.update({ ...side, accuracy: 5, t: (t += 1000) });
  assert.equal(osrmCalls(), before + 1);

  // Drive to the end of the new route.
  const r2 = nav.state.route;
  const s2 = createDriveSim(r2);
  for (let s = 0; s <= s2.durationS + 3 && nav.state.status !== 'arrived'; s += 1) {
    t += 1000;
    nav.update({ ...s2.fixAt(s, t), t });
  }
  assert.equal(nav.state.status, 'arrived');
  assert.equal(nav.state.progress.distanceRemainingM, 0);
  nav.update({ ...s2.fixAt(0, t), t });
  assert.equal(nav.state.status, 'arrived', 'arrival sticks until stop()');
  nav.stop();
  assert.equal(nav.state.status, 'idle');
  assert.equal(nav.state.route, undefined);
});

test('search: places through the navigator, TomTom when keyed', async () => {
  const proxy = fakeProxy({
    photon: fixture('photon-ferry-building.json'),
    'tomtom-search': fixture('tomtom-search-documented.json'),
  });
  const nav = createNavigator({ proxyClient: proxy, hasFeed: () => true });
  const places = await nav.search('ferry building', {
    near: { lat: 37.78, lon: -122.41 },
  });
  // Both providers answer; the exact name ranks first (core/search/rank.js).
  assert.equal(places[0].name, 'Ferry Building');
  assert.ok(places.some((p) => p.name === 'Ferry Building Marketplace'));
  assert.ok(places.length <= 8);
  const nav2 = createNavigator({ proxyClient: proxy, hasFeed: () => false });
  await nav2.search('ferry building');
  assert.equal(proxy.calls.filter((c) => c.feed === 'tomtom-search').length, 1);
});

test('a late signal count still lands, and re-sends the state', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const proxy = fakeProxy({
    osrm: fixture('osrm-sf-car.json'),
    overpass: () => gate.then(() => fixture('overpass-sf-signals.json')),
  });
  const nav = createNavigator({
    proxyClient: proxy,
    hasFeed: () => false,
    signalTimeoutMs: 5,
  });
  const [r] = await nav.plan(FROM, TO);
  assert.equal(r.signals, undefined);
  let sent = 0;
  nav.subscribe(() => (sent += 1));
  release();
  await flush();
  await flush();
  await flush();
  assert.equal(r.signals, 9);
  assert.equal(sent, 1);
});
