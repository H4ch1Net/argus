import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tunerStations,
  nearestIndex,
  ratioToIndex,
  pointerToTuner,
  tunerTape,
  keyStep,
  indexOfStation,
  stationClickPath,
  TUNER_SEED_PER_TAG,
} from './tuner.js';

const st = (id, clicks, tags = [], name = id) => ({
  id: `radio:${id}`,
  meta: { name, clicks, tags },
});

test('station order: specialist tags seeded first, then by clicks, capped', () => {
  const list = [
    st('pop1', 900, ['pop']),
    st('pop2', 800, ['pop']),
    st('news1', 50, ['news', 'talk']),
    st('wx1', 10, ['Weather']),
    st('talk1', 70, ['talk_radio']),
    st('pop3', 800, ['pop'], 'A pop'),
  ];
  assert.deepEqual(
    tunerStations(list).map((s) => s.id),
    [
      'radio:news1', // news seed (also tagged talk, but placed once)
      'radio:talk1', // talk seed ('talk_radio' reads as 'talk radio')
      'radio:wx1', // weather seed
      'radio:pop1',
      'radio:pop3', // equal clicks: by name ('A pop' before 'pop2')
      'radio:pop2',
    ],
  );
  assert.equal(tunerStations(list, { limit: 2 }).length, 2);
  const many = Array.from({ length: 100 }, (_, i) => st(`n${i}`, i, ['news']));
  const order = tunerStations(many);
  assert.equal(order.length, 100);
  // The first 45 are the seeds in catalogue (input) order; the rest by clicks.
  assert.equal(order[0].id, 'radio:n0');
  assert.equal(order[TUNER_SEED_PER_TAG - 1].id, `radio:n${TUNER_SEED_PER_TAG - 1}`);
  assert.equal(order[TUNER_SEED_PER_TAG].id, 'radio:n99');
  assert.equal(
    tunerStations(Array.from({ length: 900 }, (_, i) => st(`s${i}`, i))).length,
    750,
  );
  assert.deepEqual(tunerStations(null), []);
});

test('ratio and pointer map to the nearest station', () => {
  assert.equal(nearestIndex(2.49, 10), 2);
  assert.equal(nearestIndex(2.5, 10), 3);
  assert.equal(nearestIndex(-4, 10), 0);
  assert.equal(nearestIndex(40, 10), 9);
  assert.equal(nearestIndex(1, 0), -1);
  assert.deepEqual(ratioToIndex(0.5, 11), { coordinate: 5, stationIndex: 5 });
  assert.deepEqual(ratioToIndex(2, 11), { coordinate: 10, stationIndex: 10 });
  assert.deepEqual(ratioToIndex(0.3, 1), { coordinate: 0, stationIndex: 0 });
  assert.deepEqual(ratioToIndex(0.3, 0), { coordinate: 0, stationIndex: -1 });
  // A 214 px dial at x=100 with a 7 px inset: usable 200 px.
  assert.deepEqual(pointerToTuner(107, 100, 214, 11), {
    ratio: 0,
    coordinate: 0,
    stationIndex: 0,
  });
  assert.deepEqual(pointerToTuner(207, 100, 214, 11), {
    ratio: 0.5,
    coordinate: 5,
    stationIndex: 5,
  });
  assert.equal(pointerToTuner(9999, 100, 214, 11).stationIndex, 10);
  assert.equal(pointerToTuner(0, 100, 214, 11).stationIndex, 0);
  assert.equal(pointerToTuner(150, 100, 214, 0).stationIndex, -1);
});

test('the tape: pitch, needle, visible ticks and labels', () => {
  // 101 stations on a 214 px dial: a 2 px directory step, so the 14 px floor wins.
  const tape = tunerTape(50, 101, 214);
  assert.equal(tape.pitchPx, 14);
  assert.equal(tape.needleX, 7 + 2 * 50);
  assert.equal(tape.ratio, 0.5);
  const cur = tape.ticks.find((t) => t.current);
  assert.equal(cur.stationIndex, 50);
  assert.equal(cur.xPx, tape.needleX);
  assert.equal(cur.label, '051');
  // Only the stretch around the needle (plus overscan) is built.
  assert.ok(tape.ticks.length < 25);
  for (const t of tape.ticks) {
    assert.equal(
      t.label !== '',
      t.current || t.channel % 6 === 0 || t.stationIndex === 0 || t.stationIndex === 100,
    );
  }
  // Few stations on a wide dial: 5x the directory step sets the pitch.
  assert.equal(tunerTape(0, 3, 214).pitchPx, 5 * 100);
  assert.equal(tunerTape(0, 3, 214).ticks[0].label, '01');
  assert.deepEqual(tunerTape(0, 0, 214).ticks, []);
  assert.equal(tunerTape(0, 1, 214).ticks[0].current, true);
});

test('keyboard steps clamp to the dial and ignore other keys', () => {
  assert.equal(keyStep('ArrowRight', 3, 10), 4);
  assert.equal(keyStep('ArrowUp', 9, 10), 9);
  assert.equal(keyStep('ArrowLeft', 0, 10), 0);
  assert.equal(keyStep('ArrowDown', 5, 10), 4);
  assert.equal(keyStep('PageUp', 0, 101), 10);
  assert.equal(keyStep('PageDown', 5, 101), 0);
  assert.equal(keyStep('Home', 50, 101), 0);
  assert.equal(keyStep('End', 0, 101), 100);
  assert.equal(keyStep('Enter', 0, 101), null);
  assert.equal(keyStep('ArrowRight', 0, 0), null);
});

test('station lookup and the click-count path', () => {
  const list = [st('a', 1), st('b', 2)];
  assert.equal(indexOfStation(list, 'radio:b'), 1);
  assert.equal(indexOfStation(list, 'radio:z'), -1);
  const uuid = '9617A958-0601-11E8-AE97-52543BE04C81';
  assert.equal(
    stationClickPath(`radio:${uuid}`),
    '/json/url/9617a958-0601-11e8-ae97-52543be04c81',
  );
  assert.equal(stationClickPath({ id: `radio:${uuid}` }), stationClickPath(uuid));
  assert.equal(stationClickPath('radio:../../json/stations'), null);
  assert.equal(stationClickPath(null), null);
});
