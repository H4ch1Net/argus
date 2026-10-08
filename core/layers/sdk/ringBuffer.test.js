import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingBuffer } from './ringBuffer.js';

test('retains up to capacity, dropping oldest', () => {
  const rb = createRingBuffer(3);
  rb.push(1).push(2).push(3).push(4);
  assert.equal(rb.size, 3);
  assert.deepEqual(rb.toArray(), [2, 3, 4]);
  assert.equal(rb.last(), 4);
  assert.equal(rb.prev(), 3);
});

test('last/prev on a short buffer', () => {
  const rb = createRingBuffer(5);
  assert.equal(rb.last(), undefined);
  rb.push(9);
  assert.equal(rb.last(), 9);
  assert.equal(rb.prev(), undefined);
});

test('rejects a non-positive capacity', () => {
  assert.throws(() => createRingBuffer(0));
});

test('sampleAt brackets and interpolates across the window, clamping at ends', () => {
  const rb = createRingBuffer(10);
  rb.push({ t: 0, v: 0 }).push({ t: 10, v: 100 }).push({ t: 20, v: 200 });
  // linear interp on v for the test
  const interp = (a, b, t) => ({ t, v: a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t) });
  assert.equal(rb.sampleAt(5, interp).v, 50); // between fix 0 and 1
  assert.equal(rb.sampleAt(15, interp).v, 150); // between fix 1 and 2
  assert.equal(rb.sampleAt(-5, interp).v, 0); // clamp to oldest
  assert.equal(rb.sampleAt(999, interp).v, 200); // clamp to newest
  assert.equal(createRingBuffer(3).sampleAt(1, interp), undefined); // empty
});

test('prepend backfills older fixes and grows the buffer to keep them', () => {
  const rb = createRingBuffer(3);
  rb.push({ t: 10 }).push({ t: 20 }).push({ t: 30 });
  const added = rb.prepend([{ t: 5 }, { t: 1 }, { t: 25 }, { t: Number.NaN }], 10);
  assert.equal(added, 2, 'only fixes older than the oldest retained one');
  assert.deepEqual(
    rb.toArray().map((f) => f.t),
    [1, 5, 10, 20, 30],
  );
  rb.push({ t: 40 });
  assert.equal(
    rb.size,
    5,
    'the grown capacity holds: the next fix drops only the oldest',
  );
  assert.equal(rb.toArray()[0].t, 5);
  const capped = createRingBuffer(2);
  capped.push({ t: 10 });
  capped.prepend([{ t: 1 }, { t: 2 }, { t: 3 }], 3);
  assert.deepEqual(
    capped.toArray().map((f) => f.t),
    [2, 3, 10],
    'never beyond the limit',
  );
});
