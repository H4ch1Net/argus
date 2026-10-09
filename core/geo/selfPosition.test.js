import { afterEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRESH_MS,
  bearingDeg,
  createFixFilter,
  createSelfPosition,
  distanceM,
  normalizeFix,
} from './selfPosition.js';
import { SELF_ICON_IDS } from '../ui/selfIcons.js';

const T0 = 1_760_000_000_000;
const flush = () => new Promise((r) => setImmediate(r));

// A point d metres from (lat, lon) due north / east (small distances).
const north = (lat, lon, d) => [lat + d / 111_195, lon];
const east = (lat, lon, d) => [
  lat,
  lon + d / (111_195 * Math.cos((lat * Math.PI) / 180)),
];

const fix = (lat, lon, accuracy, t, extra = {}) =>
  normalizeFix({ lat, lon, accuracy, t, source: 'test', ...extra }, t);

function fakeGeo() {
  const g = { watches: new Map(), quick: [], seq: 0, cleared: [] };
  g.watchPosition = (ok, err, opts) => {
    g.seq += 1;
    g.watches.set(g.seq, { ok, err, opts });
    return g.seq;
  };
  g.clearWatch = (id) => {
    g.watches.delete(id);
    g.cleared.push(id);
  };
  g.getCurrentPosition = (ok, err, opts) => g.quick.push({ ok, err, opts });
  const position = (lat, lon, accuracy, t, { heading = null, speed = null } = {}) => ({
    coords: { latitude: lat, longitude: lon, accuracy, heading, speed, altitude: null },
    timestamp: t,
  });
  g.emit = (...a) => {
    for (const w of g.watches.values()) w.ok(position(...a));
  };
  g.answerQuick = (...a) => g.quick.shift()?.ok(position(...a));
  g.deny = () => {
    for (const w of [...g.watches.values()]) w.err({ code: 1, message: 'denied' });
  };
  return g;
}

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  };
}

function fakeDoc() {
  const listeners = new Set();
  return {
    hidden: false,
    addEventListener: (type, fn) => type === 'visibilitychange' && listeners.add(fn),
    removeEventListener: (type, fn) => listeners.delete(fn),
    setHidden(h) {
      this.hidden = h;
      for (const fn of listeners) fn();
    },
  };
}

// Every model made by a test is torn down after it (its timers would keep the
// process alive under a frozen test clock).
const made = [];
afterEach(() => {
  for (const m of made.splice(0)) m.destroy();
});

function makeModel(over = {}) {
  const clock = { t: T0 };
  const geo = over.geolocation ?? fakeGeo();
  const storage = over.storage ?? fakeStorage();
  const doc = over.doc ?? fakeDoc();
  const logs = [];
  const sp = createSelfPosition(null, {
    geolocation: geo,
    host: null,
    storage,
    doc,
    now: () => clock.t,
    log: (e) => logs.push(e),
    ...over,
  });
  made.push(sp);
  return { sp, geo, storage, doc, clock, logs };
}

// ------------------------------------------------------------------ helpers

test('distance and bearing', () => {
  const a = { lat: 51.5, lon: -0.12 };
  const [la, lo] = north(a.lat, a.lon, 1000);
  assert.ok(Math.abs(distanceM(a, { lat: la, lon: lo }) - 1000) < 1);
  assert.ok(Math.abs(bearingDeg(a, { lat: la, lon: lo })) < 0.01);
  const [la2, lo2] = east(a.lat, a.lon, 500);
  assert.ok(Math.abs(bearingDeg(a, { lat: la2, lon: lo2 }) - 90) < 0.1);
});

test('normalizeFix keeps positions only and clamps a future time', () => {
  assert.equal(normalizeFix(null), null);
  assert.equal(normalizeFix({ lat: 91, lon: 0 }), null);
  assert.equal(normalizeFix({ lat: 0, lon: 0 }), null); // no fix reads as 0,0
  assert.equal(normalizeFix({ lat: 'x', lon: 2 }), null);
  const f = normalizeFix(
    { lat: 10, lon: 20, accuracy: -3, heading: 370, speed: -1, t: T0 + 9e6 },
    T0,
  );
  assert.equal(f.t, T0);
  assert.equal(f.accuracy, null);
  assert.equal(f.heading, 10);
  assert.equal(f.speed, null);
  assert.equal(normalizeFix({ lat: 10, lon: 20 }, T0).t, T0);
});

// ------------------------------------------------------------------- filter

test('filter: an implausible jump is rejected until fixes agree on it', () => {
  const f = createFixFilter();
  assert.ok(f.push(fix(48.85, 2.35, 8, T0)).accepted);
  // 3 km in one second with 8 m accuracy: a glitch.
  const [jl, jo] = north(48.85, 2.35, 3000);
  const r1 = f.push(fix(jl, jo, 8, T0 + 1000));
  assert.equal(r1.accepted, false);
  assert.equal(r1.reason, 'jump');
  // Back to the real place: accepted at once.
  assert.ok(f.push(fix(48.85, 2.35, 8, T0 + 2000)).accepted);
  // A real relocation: three agreeing fixes overrule the old place.
  assert.equal(f.push(fix(jl, jo, 8, T0 + 3000)).accepted, false);
  assert.equal(f.push(fix(jl, jo, 8, T0 + 4000)).accepted, false);
  const r = f.push(fix(jl, jo, 8, T0 + 5000));
  assert.ok(r.accepted);
  assert.ok(Math.abs(r.fix.lat - jl) < 1e-9);
});

test('filter: a far but uncertain first fix is refined, not rejected', () => {
  const f = createFixFilter();
  assert.ok(f.push(fix(40.0, -3.7, 1500, T0)).accepted); // network
  const [la, lo] = north(40.0, -3.7, 900);
  assert.ok(f.push(fix(la, lo, 6, T0 + 1500)).accepted); // GPS
});

test('filter: an old or duplicate reading never replaces a newer one', () => {
  const f = createFixFilter();
  f.push(fix(10, 10, 5, T0));
  assert.equal(f.push(fix(10.0001, 10, 5, T0 - 5000)).reason, 'old');
  assert.equal(f.push(fix(10.0001, 10, 9, T0)).reason, 'dup');
});

test('filter: a worse fix loses to a better recent one, then wins as it ages', () => {
  const f = createFixFilter();
  f.push(fix(35.68, 139.76, 5, T0, { speed: 0 }));
  const [la, lo] = north(35.68, 139.76, 25);
  assert.equal(f.push(fix(la, lo, 60, T0 + 1000)).reason, 'worse');
  // A minute without GPS: the network fix is now the better guess.
  assert.ok(f.push(fix(la, lo, 60, T0 + 60_000)).accepted);
});

test('filter: a still receiver settles instead of creeping', () => {
  const f = createFixFilter();
  const base = f.push(fix(52.52, 13.405, 10, T0, { speed: 0 })).fix;
  // GPS wander of a few metres, speed 0: the position holds.
  for (let i = 1; i <= 6; i += 1) {
    const [la, lo] = (i % 2 ? north : east)(52.52, 13.405, 2 + (i % 3) * 1.5);
    const r = f.push(fix(la, lo, 10, T0 + i * 1000, { speed: 0 }));
    assert.ok(r.accepted);
    assert.equal(r.fix.lat, base.lat);
    assert.equal(r.fix.lon, base.lon);
    assert.equal(r.fix.heading, null);
  }
  // A clearly better fix moves it once.
  const [bl, bo] = north(52.52, 13.405, 4);
  const better = f.push(fix(bl, bo, 3, T0 + 8000, { speed: 0 })).fix;
  assert.ok(Math.abs(better.lat - bl) < 1e-9);
  // Out of the noise band: it moves.
  const [ml, mo] = north(52.52, 13.405, 40);
  const moved = f.push(fix(ml, mo, 3, T0 + 9000, { speed: 0 })).fix;
  assert.ok(Math.abs(moved.lat - ml) < 1e-9);
});

test('filter: heading from the course when moving', () => {
  const f = createFixFilter();
  f.push(fix(1, 1, 5, T0, { speed: 12, heading: 80 }));
  // Reported heading while moving.
  const [la, lo] = east(1, 1, 12);
  assert.equal(
    f.push(fix(la, lo, 5, T0 + 1000, { speed: 12, heading: 92 })).fix.heading,
    92,
  );
  // No reported heading: the bearing between fixes (due north here).
  const [nl, no] = north(la, lo, 15);
  const h = f.push(fix(nl, no, 5, T0 + 2000)).fix.heading;
  assert.ok(Math.abs(h) < 1 || Math.abs(h - 360) < 1, String(h));
  // Stopped: no course heading.
  assert.equal(
    f.push(fix(nl, no, 5, T0 + 3000, { speed: 0, heading: 10 })).fix.heading,
    null,
  );
});

// -------------------------------------------------------------------- model

test('locate: a recent fix answers at once, without opening sensors', async () => {
  const { sp, geo, clock } = makeModel();
  sp.push({ lat: 45, lon: 7, accuracy: 9, t: clock.t, source: 'shell' });
  clock.t += 10_000;
  const got = await sp.locate({ timeoutMs: 5000 });
  assert.equal(got.lat, 45);
  assert.equal(geo.watches.size, 0);
});

test('locate: no fix opens the watch and a quick read, resolves on the first fix, then closes', async () => {
  const { sp, geo, clock } = makeModel();
  const states = [];
  sp.watch((s) => states.push(s.status + (s.locating ? '+loc' : '')));
  const p = sp.locate({ timeoutMs: 5000 });
  assert.equal(geo.watches.size, 1);
  assert.equal(geo.quick.length, 1);
  const w = [...geo.watches.values()][0];
  assert.equal(w.opts.enableHighAccuracy, true);
  assert.equal(geo.quick[0].opts.enableHighAccuracy, false);
  geo.answerQuick(41.9, 12.5, 900, clock.t);
  const got = await p;
  assert.equal(got.lat, 41.9);
  assert.equal(got.accuracy, 900);
  // Nobody else holds the sensors: they close again.
  assert.equal(geo.watches.size, 0);
  assert.equal(sp.status(), 'live');
  assert.ok(states.includes('idle+loc'));
});

test('locate: a timeout falls back to the last known fix, else null', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const storage = fakeStorage({
      'argus.selfFix': JSON.stringify({
        lat: 59.33,
        lon: 18.06,
        accuracy: 15,
        t: T0 - 3600_000,
      }),
    });
    const { sp, logs } = makeModel({ storage });
    assert.equal(sp.get(), null); // an hour old: not handed out as current
    assert.equal(sp.lastKnown().lat, 59.33);
    const p = sp.locate({ timeoutMs: 4000 });
    mock.timers.tick(4001);
    const got = await p;
    assert.equal(got.lat, 59.33);
    assert.equal(got.source, 'cache');
    assert.ok(logs.some((e) => e.title === 'LOCATION TIMEOUT'));

    const empty = makeModel();
    const p2 = empty.sp.locate({ timeoutMs: 4000 });
    mock.timers.tick(4001);
    assert.equal(await p2, null);
  } finally {
    mock.timers.reset();
  }
});

test('locate: a fix that is not fresh does not end the wait', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { sp, geo, clock } = makeModel();
    let done = false;
    const p = sp.locate({ timeoutMs: 8000 }).then((f) => ((done = true), f));
    // The quick read hands back a cached position four minutes old.
    geo.answerQuick(30, 31, 40, clock.t - 240_000);
    await flush();
    assert.equal(done, false);
    geo.emit(30.0001, 31, 6, clock.t);
    const got = await p;
    assert.equal(got.accuracy, 6);
  } finally {
    mock.timers.reset();
  }
});

test('locate: refusal resolves null at once, logs once, and the next press tries again', async () => {
  const { sp, geo, logs } = makeModel();
  const p = sp.locate();
  geo.deny();
  assert.equal(await p, null);
  assert.equal(sp.status(), 'denied');
  assert.equal(geo.watches.size, 0);
  const p2 = sp.locate();
  assert.equal(geo.watches.size, 1); // asked again
  geo.deny();
  assert.equal(await p2, null);
  assert.equal(logs.filter((e) => e.title === 'LOCATION DENIED').length, 1);
});

test('no sensor at all: unavailable, null', async () => {
  const { sp, logs } = makeModel({ geolocation: null });
  assert.equal(await sp.locate(), null);
  assert.equal(sp.status(), 'unavailable');
  assert.ok(logs.some((e) => e.title === 'NO LOCATION SENSOR'));
});

test('locate on an open but quiet watch asks for a new reading', async () => {
  const { sp, geo, clock } = makeModel();
  sp.start('geo');
  assert.equal(geo.quick.length, 1);
  geo.answerQuick(20, 20, 30, clock.t);
  clock.t += FRESH_MS + 5000; // nothing new since: not fresh any more
  const p = sp.locate({ timeoutMs: 5000 });
  assert.equal(geo.quick.length, 1);
  assert.equal(geo.quick[0].opts.enableHighAccuracy, true);
  geo.answerQuick(20.0001, 20, 12, clock.t);
  assert.equal((await p).accuracy, 12);
  sp.stop('geo');
});

test('start/stop are held per owner; a hidden page senses nothing', () => {
  const { sp, geo, doc } = makeModel();
  sp.start('nav');
  sp.start('geo');
  assert.equal(geo.watches.size, 1);
  sp.stop('geo');
  assert.equal(geo.watches.size, 1); // nav still holds it
  doc.setHidden(true);
  assert.equal(geo.watches.size, 0);
  doc.setHidden(false);
  assert.equal(geo.watches.size, 1);
  sp.stop('nav');
  assert.equal(geo.watches.size, 0);
  sp.start();
  sp.stop();
  assert.equal(geo.watches.size, 0);
});

test('fixes are cached for the next launch and stale after FRESH_MS', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const storage = fakeStorage();
    const { sp, clock } = makeModel({ storage });
    const seen = [];
    sp.subscribe((f) => seen.push(f));
    assert.ok(sp.push({ lat: 34.05, lon: -118.24, accuracy: 7, t: clock.t }));
    assert.equal(seen.length, 1);
    assert.equal(sp.status(), 'live');
    const saved = JSON.parse(storage.getItem('argus.selfFix'));
    assert.equal(saved.lat, 34.05);
    clock.t += FRESH_MS + 1000;
    mock.timers.tick(FRESH_MS + 100);
    assert.equal(sp.status(), 'stale');
    const next = makeModel({ storage });
    next.clock.t = clock.t;
    assert.equal(next.sp.lastKnown().lat, 34.05);
  } finally {
    mock.timers.reset();
  }
});

test('heading: course when moving, the compass when still', () => {
  const { sp, clock } = makeModel();
  sp.push({ lat: 1, lon: 1, accuracy: 5, speed: 0, t: clock.t });
  assert.equal(sp.get().heading, null);
  sp.setCompass(123);
  assert.equal(sp.get().heading, 123);
  clock.t += 1000;
  const [la, lo] = east(1, 1, 15);
  sp.push({ lat: la, lon: lo, accuracy: 5, speed: 15, heading: 91, t: clock.t });
  assert.equal(sp.get().heading, 91); // moving: the course wins
  clock.t += 1000;
  sp.push({ lat: la, lon: lo, accuracy: 5, speed: 0, t: clock.t });
  clock.t += 5000; // the compass reading is old now
  assert.equal(sp.get().heading, 91); // still: the last course
  sp.setCompass(200);
  assert.equal(sp.get().heading, 200);
});

test('the Android app: native fixes through window.argusHost, no browser watch', async () => {
  const had = 'window' in globalThis;
  const prev = globalThis.window;
  globalThis.window = {};
  try {
    const calls = [];
    const host = {
      startLocation: () => calls.push('start'),
      stopLocation: () => calls.push('stop'),
    };
    const { sp, geo, clock } = makeModel({ host });
    assert.deepEqual(calls, ['stop']); // a new page resets the feed
    const p = sp.locate({ timeoutMs: 5000 });
    assert.deepEqual(calls, ['stop', 'start']);
    assert.equal(geo.watches.size, 0);
    globalThis.window.argusHost.location(-33.86, 151.21, null, 0, 4.5, clock.t, 'gps');
    const got = await p;
    assert.equal(got.source, 'gps');
    assert.equal(got.accuracy, 4.5);
    assert.equal(calls.at(-1), 'stop');
    // No provider in the app: the browser takes over.
    sp.start('nav');
    globalThis.window.argusHost.locationStatus('unavailable');
    assert.equal(geo.watches.size, 1);
    sp.stop('nav');
  } finally {
    if (had) globalThis.window = prev;
    else delete globalThis.window;
  }
});

test('icons and the selfIcon setting', () => {
  const values = new Map([['selfIcon', 'car']]);
  const subs = [];
  const settings = {
    get: (k) => values.get(k),
    set: (k, v) => {
      values.set(k, v);
      subs.forEach((fn) => fn(k, v));
      return v;
    },
    subscribe: (fn) => subs.push(fn),
  };
  const seen = [];
  const { sp } = makeModel({ settings, onIcon: (id) => seen.push(id) });
  assert.deepEqual(
    sp.icons.map((i) => i.id),
    [...SELF_ICON_IDS],
  );
  assert.equal(sp.icon, 'car');
  assert.deepEqual(seen, ['car']);
  sp.setIcon('beam');
  assert.equal(values.get('selfIcon'), 'beam');
  assert.equal(sp.icon, 'beam');
  sp.setIcon('nope');
  assert.equal(sp.icon, 'chevron');
  assert.deepEqual(seen, ['car', 'beam', 'chevron']);
});
