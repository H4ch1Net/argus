import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNavMockProxy } from './mockProxy.js';
import { createNavigator } from './navigator.js';
import { createDriveSim } from './simulate.js';

test('the demo proxy plans, counts signals and drives to arrival', async () => {
  let t = 1_000;
  const nav = createNavigator({
    proxyClient: createNavMockProxy({ delayMs: 0 }),
    hasFeed: () => false,
    now: () => t,
  });
  const places = await nav.search('coffee', { near: { lat: 51.5, lon: -0.12 } });
  assert.equal(places.length, 3);
  const routes = await nav.plan({ lat: 51.5, lon: -0.12 }, places[0]);
  assert.equal(routes.length, 2);
  for (const r of routes) {
    assert.equal(r.provider, 'osrm');
    assert.equal(r.steps.length, 3);
    assert.equal(r.steps[1].maneuver.type, 'turn');
    assert.ok(r.signals > 0, 'grid crossings on the way');
  }
  nav.start(routes[0]);
  const sim = createDriveSim(routes[0], { timeScale: 4 });
  for (let s = 0; s < sim.durationS + 3 && nav.state.status !== 'arrived'; s += 1) {
    t += 1000;
    nav.update(sim.fixAt(s, t));
  }
  assert.equal(nav.state.status, 'arrived');
  // Valhalla is not in the demo: avoid-highways falls back to OSRM and says so.
  const r2 = await nav.plan({ lat: 51.5, lon: -0.12 }, places[1], {
    avoidHighways: true,
  });
  assert.deepEqual(r2[0].warnings, ['HIGHWAYS NOT AVOIDED']);
});
