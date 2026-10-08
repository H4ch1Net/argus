import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResponseCache } from '../lib/cache.js';

const body = (n) => Buffer.alloc(n, 1);

test('entries expire by the age the caller allows', () => {
  let t = 0;
  const c = createResponseCache({ now: () => t });
  c.set('k', { status: 200, headers: {}, body: body(3) });
  t = 500;
  assert.equal(c.get('k', 1000).ageMs, 500);
  assert.equal(c.get('k', 100), null);
});

test('evicts the oldest entries past the entry and byte limits', () => {
  const c = createResponseCache({ maxEntries: 2, maxBytes: 100 });
  c.set('a', { status: 200, headers: {}, body: body(10) });
  c.set('b', { status: 200, headers: {}, body: body(10) });
  c.set('c', { status: 200, headers: {}, body: body(10) });
  assert.equal(c.get('a', 1e9), null);
  assert.ok(c.get('c', 1e9));
  c.set('d', { status: 200, headers: {}, body: body(24) });
  c.set('e', { status: 200, headers: {}, body: body(24) });
  assert.equal(c.size, 2);
  // a body over a quarter of the budget is never cached
  c.set('huge', { status: 200, headers: {}, body: body(30) });
  assert.equal(c.get('huge', 1e9), null);
});
