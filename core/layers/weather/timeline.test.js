import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherTimeline } from './timeline.js';
import { createTimedWeatherSource } from './timedSource.js';

const T0 = Date.UTC(2026, 9, 8, 12, 0);
const at = (min) => new Date(T0 + min * 60_000).toISOString();

// A manual timer, so play can be stepped deterministically.
function fakeTimers() {
  let pending = null;
  return {
    setTimeout: (fn) => ((pending = fn), 1),
    clearTimeout: () => (pending = null),
    fire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
    get armed() {
      return pending !== null;
    },
  };
}

test('latest mode shows each product its newest frame', () => {
  const tl = createWeatherTimeline();
  tl.register('radar', { maxGapMs: 30 * 60_000 });
  assert.deepEqual(tl.frameFor('radar'), { time: null, live: true });
  tl.setTimes('radar', [at(-8), at(0), at(-4)]);
  assert.deepEqual(tl.frameFor('radar'), { time: at(0), live: true });
  assert.equal(tl.getState().mode, 'latest');
});

test('history mode snaps each product to its own frame within its gap', () => {
  const tl = createWeatherTimeline();
  tl.register('radar', { maxGapMs: 30 * 60_000, times: [at(-60), at(-30), at(0)] });
  tl.register('clouds', { maxGapMs: 180 * 60_000, times: [at(-180), at(-60)] });
  tl.setTarget(at(-50));
  const s = tl.getState();
  assert.equal(s.mode, 'history');
  assert.equal(s.target, at(-50));
  assert.equal(s.frames.radar, at(-60));
  assert.equal(s.frames.clouds, at(-60));
  tl.setTarget(at(-170));
  assert.deepEqual(tl.frameFor('radar'), { time: null, live: false }); // nothing near
  assert.equal(tl.frameFor('clouds').time, at(-180));
  assert.deepEqual(s.timeline, [at(-180), at(-60), at(-30), at(0)]);
  assert.throws(() => tl.setTarget('yesterday'));
});

test('step walks the union timeline and latest returns to live', () => {
  const tl = createWeatherTimeline();
  tl.register('radar', { times: [at(-8), at(-4), at(0)] });
  assert.equal(tl.step(-1), true);
  assert.equal(tl.getState().target, at(-4));
  tl.step(-1);
  tl.step(-1); // clamps at the oldest
  assert.equal(tl.getState().target, at(-8));
  tl.step(1);
  assert.equal(tl.getState().target, at(-4));
  assert.equal(tl.step(2), false);
  tl.latest();
  assert.deepEqual(tl.getState().target, null);
  assert.equal(tl.frameFor('radar').live, true);
});

test('play loops from the oldest frame every tick and pauses on demand', () => {
  const timers = fakeTimers();
  // No overlay reports frames here, so do not wait for them.
  const tl = createWeatherTimeline({ ...timers, maxWaitMs: 0 });
  const seen = [];
  tl.subscribe((s) => seen.push(s.target));
  tl.register('radar', { times: [at(-8), at(-4), at(0)] });
  assert.equal(tl.play(), true);
  assert.equal(tl.getState().playing, true);
  assert.equal(tl.getState().target, at(-8));
  timers.fire();
  assert.equal(tl.getState().target, at(-4));
  timers.fire();
  timers.fire(); // wraps
  assert.equal(tl.getState().target, at(-8));
  tl.pause();
  assert.equal(tl.getState().playing, false);
  assert.equal(timers.armed, false);
  assert.ok(seen.includes(at(0)));
  // Fewer than two frames: nothing to play.
  const lone = createWeatherTimeline(fakeTimers());
  lone.register('radar', { times: [at(0)] });
  assert.equal(lone.play(), false);
});

test('play holds a frame until every overlay shows it, up to a cap', () => {
  const timers = fakeTimers();
  const tl = createWeatherTimeline({ ...timers, frameMs: 2000, maxWaitMs: 1000 });
  tl.register('radar', { times: [at(-8), at(-4), at(0)] });
  tl.register('goes', { times: [at(-10), at(-5)] });
  tl.play();
  assert.equal(tl.getState().target, at(-10));
  assert.equal(tl.getState().loading, true);
  tl.markShown('goes', at(-10)); // radar has no frame at or before -10: only goes counts
  assert.equal(tl.getState().loading, false);
  timers.fire();
  assert.equal(tl.getState().target, at(-8));
  // radar must show -8 and goes -10 (still its newest at or before -8).
  timers.fire(); // frame time passed, radar not shown: wait
  assert.equal(tl.getState().target, at(-8));
  tl.markShown('radar', at(-8));
  timers.fire();
  assert.equal(tl.getState().target, at(-5));
  // A frame that never shows is skipped after maxWaitMs (4 polls of 250 ms).
  for (let i = 0; i < 6; i++) timers.fire();
  assert.notEqual(tl.getState().target, at(-5));
  assert.deepEqual(tl.getState().shown, { radar: at(-8), goes: at(-10) });
});

test('register is shared and leaving drops the product', () => {
  const tl = createWeatherTimeline();
  const a = tl.register('radar', { times: [at(0)] });
  const b = tl.register('radar');
  a();
  assert.ok('radar' in tl.getState().frames);
  b();
  b();
  assert.equal('radar' in tl.getState().frames, false);
});

const capsXml = (times) => `<WMS_Capabilities><Capability><Layer>
<Name>conus_base_reflectivity_mosaic</Name>
<EX_GeographicBoundingBox><westBoundLongitude>-127</westBoundLongitude><eastBoundLongitude>-65</eastBoundLongitude><southBoundLatitude>20</southBoundLatitude><northBoundLatitude>52</northBoundLatitude></EX_GeographicBoundingBox>
<Dimension name="time" units="ISO8601" default="${times.at(-1)}">${times.join(',')}</Dimension>
</Layer></Capability></WMS_Capabilities>`;

test('the timed source learns times, pins frames, and refreshes only on its own change', async () => {
  let clock = T0;
  const requests = [];
  const proxyClient = {
    buildUrl: (feed, path) => `https://proxy.test/feed/${feed}${path}`,
    async getText(feed, path, { params }) {
      requests.push({ feed, path, params });
      return capsXml([at(-8), at(-4), at(0)]);
    },
  };
  const tl = createWeatherTimeline(fakeTimers());
  const src = createTimedWeatherSource({
    productId: 'radar',
    proxyClient,
    timeline: tl,
    now: () => clock,
  });
  let changes = 0;
  const off = src.subscribe(() => changes++);
  const live = await src({});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].feed, 'nowcoast');
  assert.equal(requests[0].path, '/weather_radar/ows');
  assert.equal(requests[0].params.request, 'GetCapabilities');
  assert.equal(live.parameters.time, at(0));
  assert.equal(live.parameters._, undefined);
  assert.equal(changes, 0); // its own report is not a change
  tl.setTarget(at(-5));
  assert.equal(changes, 1);
  const past = await src({});
  assert.equal(past.parameters.time, at(-8));
  assert.equal(requests.length, 1); // metadata still fresh
  tl.setTarget(at(-6)); // same frame (at -8): no refresh
  assert.equal(changes, 1);
  tl.setTarget(at(-60));
  const none = await src({});
  assert.equal(none.kind, 'empty');
  clock += 3 * 60_000;
  await src({});
  assert.equal(requests.length, 2); // TTL passed
  src.shown(past);
  assert.equal(tl.getState().shown.radar, at(-8));
  src.shown(none);
  assert.equal(tl.getState().shown.radar, null);
  off();
  assert.equal('radar' in tl.getState().frames, false);
});

test('without capabilities the live view falls back to the untimed latest step', async () => {
  const tl = createWeatherTimeline(fakeTimers());
  const src = createTimedWeatherSource({
    productId: 'lightning',
    proxyClient: {
      buildUrl: (feed, path) => `https://proxy.test/feed/${feed}${path}`,
      getText: async () => {
        throw new Error('proxy nowcoast responded 502');
      },
    },
    timeline: tl,
  });
  src.subscribe(() => {});
  const spec = await src({});
  assert.equal(spec.kind, 'wms');
  assert.equal(spec.parameters.time, undefined);
  assert.ok(spec.parameters._);
  tl.setTarget(at(-10));
  assert.equal((await src({})).kind, 'empty');
});
