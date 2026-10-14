import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_KEY,
  LEGACY_VIEW_KEY,
  cleanView,
  encodeSession,
  decodeSession,
  startPlan,
  readSession,
  createSessionSaver,
  sessionLayers,
  withSessionLayers,
  layerChanges,
  createSharedLayers,
} from './session.js';

const memory = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
};

const VIEW = {
  longitude: -116.21,
  latitude: 33.72,
  height: 12000,
  heading: 10,
  pitch: -45,
};
const FULL = {
  hash: '#v=1&lat=33.72&lon=-116.21&alt=12000&layers=flights,quakes&sensor=nvg',
  controls: {
    switches: { 'Mono imagery': false, 'Intel HUD': true, 'Clean view': true },
    choices: { 'Tracking boxes': 'High', 'NVG gain': 'Med', 'Base imagery': 'Dark' },
  },
  filters: { webcams: ['beach', 'city'], trafficcams: [], junk: ['x'] },
  preset: {
    id: 'sky',
    before: { layers: ['flights', 'quakes'], view: VIEW },
    staged: ['flights', 'satellites'],
  },
  at: 1_700_000_000_000,
};

test('a session round-trips; unknown controls and filters are left out', () => {
  const back = decodeSession(encodeSession(FULL));
  assert.equal(back.hash, FULL.hash);
  assert.equal(back.at, FULL.at);
  // Clean view and Base imagery are not session controls (momentary / a setting).
  assert.deepEqual(back.controls, {
    switches: { 'Mono imagery': false, 'Intel HUD': true },
    choices: { 'Tracking boxes': 'High', 'NVG gain': 'Med' },
  });
  assert.deepEqual(back.filters, { webcams: ['beach', 'city'], trafficcams: [] });
  assert.deepEqual(back.preset, FULL.preset);
});

test('decoding fails closed per field', () => {
  assert.equal(decodeSession(null), null);
  assert.equal(decodeSession('{nope'), null);
  assert.equal(decodeSession(JSON.stringify({ v: 2, hash: '#v=1' })), null);
  assert.equal(decodeSession('x'.repeat(20_000)), null);
  const bad = decodeSession(
    JSON.stringify({
      v: 1,
      hash: 'javascript:alert(1)',
      controls: { switches: { 'Intel HUD': 'yes' }, choices: { 'NVG gain': '<b>' } },
      filters: { webcams: 'beach' },
      preset: { id: 'sky', before: { layers: ['flights'], view: { longitude: 500 } } },
    }),
  );
  assert.equal(bad.hash, null);
  assert.deepEqual(bad.controls, { switches: {}, choices: {} });
  assert.deepEqual(bad.filters, {});
  // A bad "before" view drops only the way back, not the preset.
  assert.deepEqual(bad.preset, { id: 'sky' });
  // A preset or layer this device does not offer is dropped.
  const text = encodeSession(FULL);
  assert.equal(decodeSession(text, { presetIds: ['around-me'] }).preset, null);
  assert.deepEqual(
    decodeSession(text, { presetIds: ['sky'], layerKeys: ['flights'] }).preset.before
      .layers,
    ['flights'],
  );
});

test('cleanView keeps a getView() shape in range only', () => {
  assert.deepEqual(cleanView(VIEW), VIEW);
  assert.equal(cleanView({ ...VIEW, height: 0 }), null);
  assert.equal(cleanView({ ...VIEW, latitude: NaN }), null);
  // An angle out of range is dropped on its own.
  const noPitch = { ...VIEW };
  delete noPitch.pitch;
  assert.deepEqual(cleanView({ ...VIEW, pitch: 400 }), noPitch);
});

test('start plan: link, then the saved session, then the defaults', () => {
  const session = decodeSession(encodeSession(FULL));
  // A link in the address bar always wins.
  assert.equal(
    startPlan({ shell: 'mobile', hash: '#v=1&layers=', session }).kind,
    'link',
  );
  // Where I left (the default) resumes on the phone and the desktop.
  for (const shell of ['mobile', 'desktop']) {
    const p = startPlan({ shell, hash: '', startView: 'last', session });
    assert.equal(p.kind, 'session');
    assert.equal(p.hash, FULL.hash);
  }
  // First launch: nothing saved. The phone goes Around Me, the desktop default.
  assert.equal(startPlan({ shell: 'mobile', hash: '' }).kind, 'aroundme');
  assert.equal(startPlan({ shell: 'desktop', hash: '#' }).kind, 'default');
  // An older version's last view still resumes (once, until the next save).
  const legacy = startPlan({ shell: 'desktop', legacyView: '#v=1&layers=quakes' });
  assert.deepEqual(legacy, {
    kind: 'session',
    hash: '#v=1&layers=quakes',
    session: null,
  });
  // "Start in: default view" ignores the session; "Around me" everywhere.
  assert.equal(
    startPlan({ shell: 'mobile', startView: 'default', session }).kind,
    'aroundme',
  );
  assert.equal(
    startPlan({ shell: 'desktop', startView: 'default', session }).kind,
    'default',
  );
  assert.equal(
    startPlan({ shell: 'desktop', startView: 'aroundme', session }).kind,
    'aroundme',
  );
  // The car never resumes the phone's session.
  assert.equal(startPlan({ shell: 'car', session }).kind, 'default');
});

test('readSession survives blocked storage and reads the legacy view', () => {
  const st = memory({ [SESSION_KEY]: encodeSession(FULL), [LEGACY_VIEW_KEY]: '#v=1' });
  const r = readSession(st);
  assert.equal(r.session.hash, FULL.hash);
  assert.equal(r.legacyView, '#v=1');
  const blocked = {
    getItem: () => {
      throw new Error('denied');
    },
  };
  assert.deepEqual(readSession(blocked), { session: null, legacyView: null });
  assert.deepEqual(readSession(null), { session: null, legacyView: null });
});

test('the saver debounces, caps the wait, flushes at once, and survives bad storage', () => {
  let t = 0;
  const timers = [];
  const setTimer = (fn, ms) => {
    const id = { fn, at: t + ms };
    timers.push(id);
    return id;
  };
  const clearTimer = (id) => {
    const i = timers.indexOf(id);
    if (i >= 0) timers.splice(i, 1);
  };
  const advance = (ms) => {
    t += ms;
    for (const id of [...timers]) if (id.at <= t) (clearTimer(id), id.fn());
  };
  const st = memory();
  let n = 0;
  const saver = createSessionSaver({
    storage: st,
    collect: () => ({ hash: `#v=1&layers=l${(n += 1)}` }),
    delayMs: 800,
    maxWaitMs: 2000,
    now: () => t,
    setTimer,
    clearTimer,
  });
  saver.schedule();
  advance(500);
  saver.schedule(); // a second change: wait again
  advance(500);
  assert.equal(st.raw.has(SESSION_KEY), false);
  advance(300);
  assert.equal(JSON.parse(st.raw.get(SESSION_KEY)).hash, '#v=1&layers=l1');
  // Changes every 500 ms forever still save within maxWaitMs.
  for (let i = 0; i < 5; i += 1) {
    saver.schedule();
    advance(500);
  }
  assert.equal(saver.writes, 2);
  // Hidden: save now, whatever is pending.
  saver.schedule();
  assert.equal(saver.flush(), true);
  assert.equal(saver.pending, false);
  assert.equal(saver.writes, 3);
  const broken = createSessionSaver({
    storage: {
      setItem: () => {
        throw new Error('full');
      },
    },
    collect: () => ({}),
  });
  assert.equal(broken.flush(), false);
  const failing = createSessionSaver({
    storage: st,
    collect: () => {
      throw new Error('torn down');
    },
  });
  assert.equal(failing.flush(), false);
});

// ------------------------------------------------------------ shared layers
const CAR = ['incidents', 'chp', 'flights', 'radar'];
const record = (layers, extra = {}) =>
  encodeSession({
    hash: `#v=1&lat=33.72&lon=-116.21&alt=12000&layers=${layers.join(',')}&sensor=nvg`,
    controls: FULL.controls,
    ...extra,
  });

test('the shared layers are the layers in the phone record', () => {
  assert.deepEqual(sessionLayers(record(['flights', 'satellites'])), [
    'flights',
    'satellites',
  ]);
  assert.deepEqual(sessionLayers(record([])), []);
  assert.equal(sessionLayers(null), null);
  assert.equal(sessionLayers('{"v":1}'), null);
  assert.equal(sessionLayers(encodeSession({ hash: '#v=1&lat=1&lon=2&alt=3' })), null);
  assert.equal(sessionLayers('not json'), null);
});

test('the car changes only the keys in its scope, and never starts a record', () => {
  const before = record(['satellites', 'flights', 'quakes']);
  const after = withSessionLayers(before, ['incidents', 'radar', 'satellites'], CAR, 5);
  // satellites and quakes are outside the car's scope: kept as they were;
  // flights (in scope, not chosen) goes off; incidents and radar come on.
  assert.deepEqual(sessionLayers(after), ['satellites', 'quakes', 'incidents', 'radar']);
  const s = decodeSession(after);
  assert.equal(s.at, 5);
  assert.match(
    s.hash,
    /^#v=1&lat=33\.72&lon=-116\.21&alt=12000&layers=[a-z,]+&sensor=nvg$/,
  );
  assert.deepEqual(s.controls, decodeSession(before).controls);
  // A record without a layers field gets one.
  const bare = encodeSession({ hash: '#v=1&lat=1&lon=2&alt=3' });
  assert.deepEqual(sessionLayers(withSessionLayers(bare, ['chp'], CAR)), ['chp']);
  assert.equal(withSessionLayers(null, ['chp'], CAR), null);
  assert.equal(withSessionLayers('{"v":2}', ['chp'], CAR), null);
  // Junk keys never reach the record.
  const junk = withSessionLayers(bare, ['BAD KEY', 'chp'], [...CAR, 'BAD KEY']);
  assert.deepEqual(sessionLayers(junk), ['chp']);
});

test('layer changes between two records, within a scope', () => {
  const a = record(['flights', 'satellites']);
  const b = record(['satellites', 'incidents', 'quakes']);
  assert.deepEqual(layerChanges(a, b), { on: ['incidents', 'quakes'], off: ['flights'] });
  assert.deepEqual(layerChanges(a, b, new Set(CAR)), {
    on: ['incidents'],
    off: ['flights'],
  });
  assert.deepEqual(layerChanges(null, b, new Set(CAR)), { on: ['incidents'], off: [] });
  // A removed or unreadable record changes nothing.
  assert.deepEqual(layerChanges(a, null), { on: [], off: [] });
  assert.deepEqual(layerChanges(a, 'junk'), { on: [], off: [] });
});

test('shared layers: read, write and follow the other page', () => {
  const st = memory({ [SESSION_KEY]: record(['flights', 'satellites']) });
  const events = new Map();
  const target = {
    addEventListener: (t, fn) => events.set(t, fn),
    removeEventListener: (t) => events.delete(t),
  };
  const doc = { visibilityState: 'visible', ...target };
  const seen = [];
  const car = createSharedLayers({
    storage: st,
    scope: CAR,
    apply: (c) => seen.push(c),
    target,
    doc,
    now: () => 7,
  });
  assert.deepEqual(car.read(), ['flights']);
  assert.equal(car.write(['incidents']), true);
  assert.deepEqual(sessionLayers(st.raw.get(SESSION_KEY)), ['satellites', 'incidents']);
  assert.equal(decodeSession(st.raw.get(SESSION_KEY)).at, 7);
  // The phone writes: radar on, satellites off; only radar is the car's.
  const phone = record(['incidents', 'radar']);
  events.get('storage')({
    key: SESSION_KEY,
    oldValue: st.raw.get(SESSION_KEY),
    newValue: phone,
    storageArea: st,
  });
  assert.deepEqual(seen, [{ on: ['radar'], off: [] }]);
  // Other keys and other storage areas are not ours.
  events.get('storage')({ key: 'argus.settings', oldValue: null, newValue: phone });
  events.get('storage')({ key: SESSION_KEY, newValue: record([]), storageArea: {} });
  assert.equal(seen.length, 1);
  // Shown again with what the event already brought: nothing new.
  st.setItem(SESSION_KEY, phone);
  events.get('visibilitychange')();
  assert.equal(seen.length, 1);
  // No event (a page that does not get them): caught up when shown.
  st.setItem(SESSION_KEY, record(['chp']));
  doc.visibilityState = 'hidden';
  events.get('visibilitychange')();
  assert.equal(seen.length, 1);
  doc.visibilityState = 'visible';
  events.get('visibilitychange')();
  assert.deepEqual(seen[1], { on: ['chp'], off: ['incidents', 'radar'] });
  car.stop();
  assert.equal(events.size, 0);
  // No record (a first run): nothing to read, nothing written.
  const empty = createSharedLayers({ storage: memory(), scope: CAR, target, doc });
  assert.equal(empty.read(), null);
  assert.equal(empty.write(['chp']), false);
  // Without a scope a write is the whole set (the phone's side).
  const all = createSharedLayers({ storage: st, target, doc });
  assert.equal(all.write(['quakes']), true);
  assert.deepEqual(all.read(), ['quakes']);
  // Storage that throws: no crash.
  const blocked = createSharedLayers({
    storage: {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    },
    scope: CAR,
    target,
    doc,
  });
  assert.equal(blocked.read(), null);
  assert.equal(blocked.write(['chp']), false);
});
