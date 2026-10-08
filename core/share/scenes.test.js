import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScene,
  validateShot,
  serializeScene,
  parseSceneJson,
  createSceneStore,
  planPlayback,
  describeCamera,
  shotLabel,
  formatDuration,
  cleanName,
  moveItem,
  shotFromShareState,
  shareStateFromShot,
  SCENE_MAX_BYTES,
  SCENE_MAX_SHOTS,
  SCENE_STORAGE_KEY,
} from './scenes.js';
import { encodeShareHash, decodeShareHash } from './state.js';

const CAM = { lon: 2.2945, lat: 48.8584, alt: 12000, heading: 30, pitch: -35, roll: 0 };
const SHOT = {
  camera: CAM,
  layers: ['flights', 'quakes'],
  look: 'nvg',
  target: { layer: 'flights', id: '3c6444' },
  holdMs: 4000,
  flyMs: 3000,
  caption: 'Eiffel Tower',
};
const SCENE = { v: 1, name: 'Paris', shots: [SHOT] };

/** A localStorage stand-in; `fail` makes getItem / setItem throw. */
function memoryStorage(fail = {}) {
  const map = new Map();
  return {
    map,
    getItem(k) {
      if (fail.get) throw new Error('SecurityError');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (fail.set) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
  };
}

test('a well-formed scene validates to the same shape (a fresh object)', () => {
  const out = validateScene(SCENE);
  assert.deepEqual(out, SCENE);
  assert.notEqual(out, SCENE);
  assert.notEqual(out.shots[0].camera, CAM);
  // v may be absent (hand-written files); any other version is refused.
  assert.deepEqual(validateScene({ name: 'Paris', shots: [SHOT] }), SCENE);
  assert.equal(validateScene({ ...SCENE, v: 2 }), null);
  assert.equal(validateScene({ ...SCENE, v: '1' }), null);
});

test('numbers are clamped, wrapped and rounded; missing optional fields default', () => {
  const out = validateScene({
    name: 'x',
    shots: [
      {
        camera: { lon: 190, lat: 95, alt: 0, heading: -10, pitch: -120, roll: 270 },
        holdMs: 1e9,
        flyMs: -5,
      },
      { camera: { lon: -2.1234567891, lat: 1.0000004, alt: 2e9 } },
    ],
  });
  assert.deepEqual(out.shots[0], {
    camera: { lon: -170, lat: 90, alt: 1, heading: 350, pitch: -90, roll: -90 },
    layers: [],
    holdMs: 120000,
    flyMs: 0,
  });
  assert.deepEqual(out.shots[1], {
    camera: { lon: -2.123457, lat: 1, alt: 100_000_000, heading: 0, pitch: -90, roll: 0 },
    layers: [],
    holdMs: 4000,
    flyMs: 3000,
  });
  // A heading that rounds up to 360 reads as 0.
  assert.equal(validateShot({ camera: { ...CAM, heading: 359.999 } }).camera.heading, 0);
});

test('malformed fields are stripped, never coerced', () => {
  const shot = validateShot({
    camera: CAM,
    layers: [
      'flights',
      'flights',
      'Bad Key',
      'trafficcams',
      'a-b',
      'x'.repeat(25),
      7,
      null,
    ],
    look: '<script>',
    target: { layer: 'flights', id: 'has space' },
    holdMs: '4000',
    flyMs: NaN,
    caption: 42,
    extra: 'dropped',
    __proto__: { polluted: true },
  });
  assert.deepEqual(shot, {
    camera: CAM,
    layers: ['flights', 'trafficcams'],
    holdMs: 4000,
    flyMs: 3000,
  });
  assert.equal(
    validateShot({ ...SHOT, target: { layer: 'Flights', id: '1' } }).target,
    undefined,
  );
  assert.equal(validateShot({ ...SHOT, target: 'flights:1' }).target, undefined);
  assert.equal(validateShot({ ...SHOT, look: 'NVG' }).look, undefined);
});

test('shots without a usable camera are dropped; nothing usable is null', () => {
  const bad = [
    { camera: { lat: '48', lon: 2, alt: 100 } },
    { camera: { lat: 48, lon: Infinity, alt: 100 } },
    { camera: { lat: 48, lon: 2 } },
    { camera: [48, 2, 100] },
    { layers: ['flights'] },
    null,
    'shot',
  ];
  const out = validateScene({ name: 'mix', shots: [...bad, SHOT] });
  assert.equal(out.shots.length, 1);
  for (const v of [
    null,
    undefined,
    42,
    'scene',
    [],
    {},
    { name: 'empty', shots: [] },
    { name: 'bad', shots: bad },
    { name: 'no array', shots: { 0: SHOT } },
  ])
    assert.equal(validateScene(v), null);
  // A throwing getter fails closed instead of throwing.
  const evil = {
    name: 'x',
    get shots() {
      throw new Error('boom');
    },
  };
  assert.equal(validateScene(evil), null);
  assert.equal(
    validateShot({
      get camera() {
        throw new Error('boom');
      },
    }),
    null,
  );
});

test('caps: 64 shots, 60-char one-line names, 120-char captions, 64 layers', () => {
  const many = validateScene({ name: 'many', shots: Array(200).fill(SHOT) });
  assert.equal(many.shots.length, SCENE_MAX_SHOTS);
  const name = validateScene({ name: `  ${'n'.repeat(80)}  `, shots: [SHOT] }).name;
  assert.equal(name.length, 60);
  assert.equal(
    cleanName('a\u0000b\nc‮\u0085d   e\t'),
    'a b c d e',
    'controls become spaces, bidi overrides go, whitespace collapses',
  );
  assert.equal(validateScene({ name: 7, shots: [SHOT] }).name, 'UNTITLED');
  assert.equal(validateScene({ name: '\n\t', shots: [SHOT] }).name, 'UNTITLED');
  const cap = validateShot({ ...SHOT, caption: 'c'.repeat(500) }).caption;
  assert.equal(cap.length, 120);
  assert.equal(validateShot({ ...SHOT, caption: '   ' }).caption, undefined);
  const keys = Array.from({ length: 100 }, (_, i) => `layer${i}`);
  assert.equal(validateShot({ ...SHOT, layers: keys }).layers.length, 64);
  // Surrogate pairs are never split by the cap.
  assert.equal(cleanName('\u{1F30D}'.repeat(70)), '\u{1F30D}'.repeat(60));
});

test('serialize and parse round-trip; a maximal scene stays under the size cap', () => {
  const text = serializeScene(SCENE);
  assert.equal(typeof text, 'string');
  assert.deepEqual(parseSceneJson(text), SCENE);
  assert.equal(serializeScene({ shots: [] }), null);

  const fat = {
    v: 1,
    name: '\u{1F30D}'.repeat(60),
    shots: Array.from({ length: 64 }, () => ({
      ...SHOT,
      layers: Array.from({ length: 64 }, (_, i) => `${'k'.repeat(20)}${1000 + i}`),
      caption: '\u{1F30D}'.repeat(120),
      target: { layer: 'flights', id: 'x'.repeat(64) },
    })),
  };
  const big = serializeScene(fat);
  assert.ok(new TextEncoder().encode(big).byteLength <= SCENE_MAX_BYTES);
  assert.deepEqual(parseSceneJson(big), validateScene(fat));
});

test('parseSceneJson fails closed on size, syntax and shape', () => {
  assert.equal(parseSceneJson(null), null);
  assert.equal(parseSceneJson(''), null);
  assert.equal(parseSceneJson('{"v":1,'), null);
  assert.equal(parseSceneJson('[]'), null);
  assert.equal(parseSceneJson('"scene"'), null);
  // Over the cap in characters, and over it only in UTF-8 bytes.
  const pad = (n, ch) => JSON.stringify({ ...SCENE, junk: ch.repeat(n) });
  assert.equal(parseSceneJson(pad(SCENE_MAX_BYTES, 'a')), null);
  const multi = pad(Math.ceil(SCENE_MAX_BYTES / 3), '€');
  assert.ok(multi.length < SCENE_MAX_BYTES);
  assert.equal(parseSceneJson(multi), null);
  // A small amount of junk under the cap is ignored, not kept.
  assert.deepEqual(parseSceneJson(pad(100, 'a')), SCENE);
  // __proto__ keys never reach a prototype.
  const evil =
    '{"v":1,"name":"p","__proto__":{"polluted":1},' +
    '"shots":[{"camera":{"lat":1,"lon":2,"alt":3},"__proto__":{"polluted":1}}]}';
  const out = parseSceneJson(evil);
  assert.equal(out.shots.length, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(Object.hasOwn(out, '__proto__'), false);
});

test('planPlayback lays the shots out as fly then hold', () => {
  const plan = planPlayback({
    name: 'tour',
    shots: [
      { camera: CAM, flyMs: 3000, holdMs: 4000 },
      { camera: CAM, flyMs: 0, holdMs: 2500 },
      { camera: CAM, flyMs: 1500, holdMs: 0 },
    ],
  });
  assert.equal(plan.total, 3);
  assert.equal(plan.totalMs, 11000);
  assert.deepEqual(
    plan.steps.map((s) => [s.index, s.label, s.startMs, s.arriveMs, s.endMs]),
    [
      [0, 'SHOT 01/03', 0, 3000, 7000],
      [1, 'SHOT 02/03', 7000, 7000, 9500],
      [2, 'SHOT 03/03', 9500, 11000, 11000],
    ],
  );
  assert.equal(plan.steps[0].shot.camera.lat, CAM.lat);
  assert.deepEqual(planPlayback(null), { total: 0, totalMs: 0, steps: [] });
  assert.deepEqual(planPlayback({ shots: [] }), { total: 0, totalMs: 0, steps: [] });
});

test('readouts: camera, shot label, duration', () => {
  assert.equal(
    describeCamera({ lat: 48.8584, lon: 2.2945, alt: 12000 }),
    '48.86N 2.29E 12KM',
  );
  assert.equal(
    describeCamera({ lat: -33.86, lon: -151.21, alt: 1500 }),
    '33.86S 151.21W 1.5KM',
  );
  assert.equal(describeCamera({ lat: 0, lon: 0, alt: 350.4 }), '0.00N 0.00E 350M');
  assert.equal(describeCamera(null), '--');
  assert.equal(shotLabel(1, 5), 'SHOT 02/05');
  assert.equal(shotLabel(63, 64), 'SHOT 64/64');
  assert.equal(formatDuration(35_000), '0:35');
  assert.equal(formatDuration(725_400), '12:05');
  assert.equal(formatDuration(-1), '0:00');
});

test('moveItem returns a reordered copy and ignores out-of-range moves', () => {
  const list = ['a', 'b', 'c'];
  assert.deepEqual(moveItem(list, 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(list, 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(list, 0, -1), list);
  assert.deepEqual(moveItem(list, 2, 1), list);
  assert.deepEqual(list, ['a', 'b', 'c']);
});

test('shots convert to and from the share-link state', () => {
  const state = {
    camera: { lat: 48.8584, lon: 2.2945, alt: 12000, heading: 30, pitch: -35 },
    layers: ['flights', 'quakes'],
    sensor: 'nvg',
    imagery: 'satellite',
    track: { layer: 'flights', id: '3c6444' },
  };
  const shot = shotFromShareState(decodeShareHash(encodeShareHash(state)), {
    holdMs: 2000,
  });
  assert.deepEqual(shot, {
    camera: { ...state.camera, roll: 0 },
    layers: ['flights', 'quakes'],
    holdMs: 2000,
    flyMs: 3000,
    look: 'nvg',
    target: { layer: 'flights', id: '3c6444' },
  });
  const back = shareStateFromShot(shot);
  assert.deepEqual(back, {
    camera: state.camera,
    layers: state.layers,
    sensor: 'nvg',
    track: state.track,
  });
  assert.deepEqual(decodeShareHash(encodeShareHash(back)), { version: 1, ...back });
  assert.equal(shotFromShareState({ layers: ['flights'] }), null);
  assert.equal(shotFromShareState(null), null);
  assert.equal(shareStateFromShot({}), null);
});

test('store: save, list, get, rename, remove, keyed by name without case', () => {
  const storage = memoryStorage();
  const store = createSceneStore(storage);
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('Paris'), null);

  let r = store.save(SCENE);
  assert.deepEqual(r, { ok: true, scene: SCENE, replaced: false });
  r = store.save({ name: 'Tokyo', shots: [SHOT, SHOT] });
  assert.equal(r.ok, true);
  assert.deepEqual(store.list(), [
    { name: 'Tokyo', shots: 2 },
    { name: 'Paris', shots: 1 },
  ]);
  // Same name in another case replaces it (and moves it to the front).
  r = store.save({ name: 'PARIS', shots: [SHOT, SHOT, SHOT] });
  assert.equal(r.replaced, true);
  assert.deepEqual(store.list(), [
    { name: 'PARIS', shots: 3 },
    { name: 'Tokyo', shots: 2 },
  ]);
  assert.equal(store.get('paris').shots.length, 3);
  // get hands out a copy: changing it does not change what is stored.
  store.get('tokyo').shots.length = 0;
  assert.equal(store.get('tokyo').shots.length, 2);

  assert.deepEqual(store.rename('tokyo', 'paris'), { ok: false, reason: 'exists' });
  assert.deepEqual(store.rename('nowhere', 'x'), { ok: false, reason: 'missing' });
  assert.deepEqual(store.rename('tokyo', '\n '), { ok: false, reason: 'invalid' });
  assert.deepEqual(store.rename('tokyo', 'Kyoto'), { ok: true, name: 'Kyoto' });
  assert.deepEqual(store.rename('kyoto', 'KYOTO'), { ok: true, name: 'KYOTO' });
  assert.deepEqual(
    store.list().map((s) => s.name),
    ['PARIS', 'KYOTO'],
  );

  assert.equal(store.remove('nowhere'), false);
  assert.equal(store.remove('paris'), true);
  assert.deepEqual(store.list(), [{ name: 'KYOTO', shots: 2 }]);
  assert.deepEqual(store.save({ shots: [] }), { ok: false, reason: 'invalid' });

  // What is stored is plain v=1 JSON under one key.
  const raw = JSON.parse(storage.map.get(SCENE_STORAGE_KEY));
  assert.equal(raw.v, 1);
  assert.equal(raw.scenes[0].name, 'KYOTO');
});

test('store: refuses past its cap instead of evicting', () => {
  const store = createSceneStore(memoryStorage(), { max: 2 });
  assert.equal(store.save({ name: 'a', shots: [SHOT] }).ok, true);
  assert.equal(store.save({ name: 'b', shots: [SHOT] }).ok, true);
  assert.deepEqual(store.save({ name: 'c', shots: [SHOT] }), {
    ok: false,
    reason: 'full',
  });
  assert.equal(
    store.save({ name: 'A', shots: [SHOT, SHOT] }).ok,
    true,
    'replacing is fine',
  );
  assert.equal(store.list().length, 2);
});

test('store: tolerates throwing, missing and corrupt storage', () => {
  const reads = createSceneStore(memoryStorage({ get: true }));
  assert.deepEqual(reads.list(), []);
  assert.equal(reads.get('x'), null);

  const writes = createSceneStore(memoryStorage({ set: true }));
  assert.deepEqual(writes.save(SCENE), { ok: false, reason: 'storage' });
  assert.equal(writes.remove('Paris'), false);

  for (const storage of [null, undefined]) {
    const s = createSceneStore(storage);
    assert.deepEqual(s.list(), []);
    assert.deepEqual(s.save(SCENE), { ok: false, reason: 'storage' });
  }

  const storage = memoryStorage();
  const store = createSceneStore(storage);
  for (const raw of ['{', '[]', '{"v":2,"scenes":[]}', '{"v":1,"scenes":{}}', '42']) {
    storage.map.set(SCENE_STORAGE_KEY, raw);
    assert.deepEqual(store.list(), [], raw);
  }
  // Bad and duplicate entries are dropped on read; the good ones survive.
  storage.map.set(
    SCENE_STORAGE_KEY,
    JSON.stringify({
      v: 1,
      scenes: [{ name: 'bad', shots: [] }, SCENE, { ...SCENE, name: 'paris' }, 'junk'],
    }),
  );
  assert.deepEqual(store.list(), [{ name: 'Paris', shots: 1 }]);
  // Saving over a corrupt store writes a clean one.
  storage.map.set(SCENE_STORAGE_KEY, '{');
  assert.equal(store.save(SCENE).ok, true);
  assert.deepEqual(store.list(), [{ name: 'Paris', shots: 1 }]);
});
