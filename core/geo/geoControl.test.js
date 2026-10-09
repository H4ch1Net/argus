import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { altitudeFor, createGeoControl as create, flyToSelf } from './geoControl.js';

// Controls made by a test are torn down after it (their hold timers would
// keep the process alive).
const made = [];
afterEach(() => {
  for (const g of made.splice(0)) g.destroy();
});
const createGeoControl = (deps) => {
  const g = create(deps);
  made.push(g);
  return g;
};

const T0 = 1_760_000_000_000;
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

// A camera whose flights land when the test says so (or at once).
function fakeCamera({ instant = true } = {}) {
  const cam = {
    view: { longitude: 0, latitude: 0, height: 2e7, heading: 0, pitch: -90 },
    flights: [],
    flyTos: [],
    getView: () => ({ ...cam.view }),
    flyAround(o) {
      let resolve;
      const p = new Promise((r) => (resolve = r));
      const f = { o, land: () => land(f), cancel: () => resolve(false) };
      const land = (fl) => {
        cam.view = {
          longitude: fl.o.longitude,
          latitude: fl.o.latitude,
          height: fl.o.range,
          heading: fl.o.heading,
          pitch: -90,
        };
        resolve(true);
      };
      cam.flights.push(f);
      if (instant) land(f);
      return p;
    },
    flyTo: (o) => cam.flyTos.push(o),
  };
  return cam;
}

// The selfPosition surface GEO uses, with a controllable locate().
function fakeSelf({ fix = null, last = null, status = 'idle' } = {}) {
  const sp = {
    current: fix,
    last,
    st: status,
    holds: new Map(),
    following: false,
    pendingLocate: null,
    watchers: new Set(),
    subs: new Set(),
    get: () => sp.current,
    lastKnown: () => sp.current ?? sp.last,
    status: () => sp.st,
    start: (o = 'default') => sp.holds.set(o, (sp.holds.get(o) ?? 0) + 1),
    stop: (o = 'default') => sp.holds.delete(o),
    locate: () =>
      new Promise((resolve) => {
        sp.pendingLocate = resolve;
      }),
    follow(on) {
      sp.following = Boolean(on);
      for (const fn of sp.watchers) fn({ following: sp.following });
      return sp.following;
    },
    watch(fn) {
      sp.watchers.add(fn);
      return () => sp.watchers.delete(fn);
    },
    subscribe(fn) {
      sp.subs.add(fn);
      return () => sp.subs.delete(fn);
    },
    emit(f) {
      sp.current = f;
      for (const fn of sp.subs) fn(f);
    },
  };
  return sp;
}

const at = (lat, lon, accuracy, t, extra = {}) => ({
  lat,
  lon,
  accuracy,
  t,
  heading: null,
  speed: 0,
  ...extra,
});

test('altitudeFor: street level for a good fix, higher for a coarse one, bounded', () => {
  assert.equal(altitudeFor({ accuracy: 5 }), 1800);
  assert.equal(altitudeFor({ accuracy: 500 }), 6000);
  assert.equal(altitudeFor({ accuracy: 50_000 }), 30_000);
  assert.equal(altitudeFor({}), 12_000);
});

test('a recent fix: one short flight at once, then follow-me, then off', async () => {
  const now = T0;
  const sp = fakeSelf({ fix: at(48.2, 16.37, 6, now - 5000) });
  const cam = fakeCamera();
  const states = [];
  let unfollowed = 0;
  const geo = createGeoControl({
    selfPosition: sp,
    camera: cam,
    now: () => now,
    beforeFollow: () => (unfollowed += 1),
  });
  geo.subscribe((s) => states.push(s.state));
  await geo.press();
  assert.equal(cam.flights.length, 1);
  assert.ok(cam.flights[0].o.duration <= 0.8);
  assert.equal(cam.flights[0].o.range, 1800);
  assert.equal(cam.flights[0].o.latitude, 48.2);
  assert.equal(geo.state, 'centered');
  assert.equal(sp.holds.get('geo'), 1);
  // Second tap while still centred: follow.
  await geo.press();
  assert.equal(geo.state, 'following');
  assert.equal(sp.following, true);
  assert.equal(unfollowed, 1);
  // Third: off again, no flight.
  await geo.press();
  assert.equal(geo.state, 'centered');
  assert.equal(sp.following, false);
  assert.equal(cam.flights.length, 1);
  assert.deepEqual(states.slice(0, 4), ['idle', 'centered', 'following', 'centered']);
});

test('the user moved after GEO: the next tap centres again instead of following', async () => {
  const sp = fakeSelf({ fix: at(1, 2, 5, T0) });
  const cam = fakeCamera();
  const geo = createGeoControl({ selfPosition: sp, camera: cam, now: () => T0 });
  await geo.press();
  cam.view = { ...cam.view, longitude: cam.view.longitude + 0.5 };
  await geo.press();
  assert.equal(sp.following, false);
  assert.equal(cam.flights.length, 2);
});

test('no recent fix: the last known place at once, LOCATING, then a hop onto the fresh fix', async () => {
  const sp = fakeSelf({ last: at(40.4, -3.7, 20, T0 - 3600_000) });
  const cam = fakeCamera();
  const notes = [];
  const geo = createGeoControl({ selfPosition: sp, camera: cam, now: () => T0 });
  geo.subscribe((s) => notes.push(`${s.state}:${s.note}`));
  const done = geo.press();
  await flush();
  assert.equal(geo.state, 'locating');
  assert.equal(cam.flights.length, 1); // the last known place, already
  assert.ok(cam.flights[0].o.range >= 4000); // coarse: some context around it
  sp.pendingLocate(at(40.401, -3.7, 6, T0));
  await done;
  assert.equal(geo.state, 'centered');
  assert.equal(cam.flights.length, 2);
  assert.ok(cam.flights[1].o.duration <= 0.6); // near: a short hop
  assert.ok(notes.includes('locating:LOCATING'));
  assert.ok(notes.includes('centered:±6 M'));
});

test('the accuracy note follows the unit setting', async () => {
  const sp = fakeSelf({ fix: at(1, 2, 14, T0) });
  const geo = createGeoControl({
    selfPosition: sp,
    camera: fakeCamera(),
    now: () => T0,
    units: () => 'imperial',
  });
  const notes = [];
  geo.subscribe((s) => notes.push(s.note));
  await geo.press();
  assert.equal(notes.at(-1), '±46 FT');
});

test('no fix at all: LOCATING with the view left alone until the first fix', async () => {
  const sp = fakeSelf();
  const cam = fakeCamera();
  const geo = createGeoControl({ selfPosition: sp, camera: cam, now: () => T0 });
  const done = geo.press();
  await flush();
  assert.equal(cam.flights.length, 0);
  await geo.press(); // a tap while locating does nothing
  assert.equal(geo.state, 'locating');
  assert.equal(cam.flights.length, 0);
  sp.pendingLocate(at(10, 10, 30, T0));
  await done;
  assert.equal(cam.flights.length, 1);
  assert.equal(geo.state, 'centered');
});

test('the user took the view while it searched: no yank back', async () => {
  const sp = fakeSelf();
  const cam = fakeCamera();
  const geo = createGeoControl({ selfPosition: sp, camera: cam, now: () => T0 });
  const done = geo.press();
  await flush();
  cam.view = { ...cam.view, latitude: 12 };
  sp.pendingLocate(at(10, 10, 30, T0));
  await done;
  assert.equal(cam.flights.length, 0);
  assert.equal(geo.state, 'idle');
});

test('refused: an error state with a short note, one log entry, back to idle', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sp = fakeSelf({ status: 'idle' });
    const cam = fakeCamera();
    const logs = [];
    const geo = createGeoControl({
      selfPosition: sp,
      camera: cam,
      now: () => T0,
      log: (e) => logs.push(e),
    });
    const seen = [];
    geo.subscribe((s) => seen.push(s));
    const done = geo.press();
    await flush();
    sp.st = 'denied';
    sp.pendingLocate(null);
    await done;
    assert.equal(geo.state, 'error');
    assert.equal(seen.at(-1).note, 'DENIED');
    assert.equal(logs.length, 1);
    assert.equal(logs[0].title, 'LOCATION DENIED');
    mock.timers.tick(3001);
    assert.equal(geo.state, 'idle');
  } finally {
    mock.timers.reset();
  }
});

test('the sensors are held while GEO is in use and released three minutes after', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sp = fakeSelf({ fix: at(1, 1, 5, T0) });
    const geo = createGeoControl({
      selfPosition: sp,
      camera: fakeCamera(),
      now: () => T0,
    });
    await geo.press();
    assert.ok(sp.holds.has('geo'));
    mock.timers.tick(3 * 60_000 + 1);
    assert.equal(sp.holds.has('geo'), false);
    // Following (a second tap, the view untouched) holds them while it lasts.
    await geo.press();
    assert.equal(geo.state, 'following');
    assert.ok(sp.holds.has('geo'));
    mock.timers.tick(10 * 60_000);
    assert.ok(sp.holds.has('geo'));
    // Something else took the camera: follow ends, the hold runs out later.
    sp.follow(false);
    assert.equal(geo.state, 'idle');
    mock.timers.tick(3 * 60_000 + 1);
    assert.equal(sp.holds.has('geo'), false);
  } finally {
    mock.timers.reset();
  }
});

test('a coarse first fix is refined while the view is untouched', async () => {
  const sp = fakeSelf();
  const cam = fakeCamera();
  const geo = createGeoControl({ selfPosition: sp, camera: cam, now: () => T0 });
  const done = geo.press();
  await flush();
  sp.pendingLocate(at(51.5, -0.12, 1500, T0));
  await done;
  assert.equal(cam.flights.length, 1);
  assert.equal(cam.flights[0].o.range, 18_000);
  // The GPS lands 800 m away: hop onto it.
  sp.emit(at(51.5072, -0.12, 5, T0));
  assert.equal(cam.flights.length, 2);
  assert.equal(cam.flights[1].o.range, 1800);
});

test('Around Me: the last known place at once, a second flight only for a real move', async () => {
  const cam = fakeCamera();
  const sp = fakeSelf({ last: at(35, 139, 20, Date.now() - 3600_000) });
  const p = flyToSelf(sp, cam, { altitude: 120_000 });
  assert.equal(cam.flyTos.length, 1);
  sp.pendingLocate(at(35.001, 139, 6, Date.now()));
  await p;
  assert.equal(cam.flyTos.length, 1); // 110 m at regional height: no second flight
  const sp2 = fakeSelf({ last: at(35, 139, 20, Date.now() - 3600_000) });
  const p2 = flyToSelf(sp2, cam, { altitude: 120_000 });
  sp2.pendingLocate(at(48, 2, 6, Date.now()));
  await p2;
  assert.equal(cam.flyTos.length, 3);
  assert.equal(cam.flyTos[2].latitude, 48);
});

test('no fix and no memory: an old fix from a sensor is shown while it keeps looking', async () => {
  const sp = fakeSelf();
  const cam = fakeCamera();
  const geo = createGeoControl({ selfPosition: sp, camera: cam, now: () => T0 });
  const done = geo.press();
  await flush();
  assert.equal(cam.flights.length, 0);
  sp.emit(at(-33.86, 151.2, 30, T0 - 5 * 60_000)); // the phone's last known, 5 min old
  assert.equal(cam.flights.length, 1);
  assert.equal(geo.state, 'locating');
  sp.pendingLocate(at(-33.861, 151.2, 5, T0));
  await done;
  assert.equal(cam.flights.length, 2);
  assert.equal(geo.state, 'centered');
});
