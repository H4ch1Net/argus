import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGovernor } from '../lib/governor.js';

const feeds = [
  {
    id: 'shodan',
    governor: {
      ratePerMinute: 3,
      creditBudget: 2,
      creditWindowMs: 1000,
      creditCost: (path) => (path.includes('/count') ? 0 : 1),
    },
  },
  { id: 'free' }, // no governor
];

test('feeds without a governor always pass at zero cost', () => {
  const g = createGovernor(feeds);
  assert.deepEqual(g.check('free', '/x'), { ok: true, cost: 0 });
});

test('count paths are free; search paths cost a credit', () => {
  const g = createGovernor(feeds);
  assert.equal(g.check('shodan', '/shodan/host/count').cost, 0);
  assert.equal(g.check('shodan', '/shodan/host/search').cost, 1);
});

test('credit budget is enforced', () => {
  const g = createGovernor(feeds);
  // Two search requests spend the budget of 2.
  for (let i = 0; i < 2; i += 1) {
    const c = g.check('shodan', '/shodan/host/search');
    assert.equal(c.ok, true);
    g.record('shodan', c.cost);
  }
  const over = g.check('shodan', '/shodan/host/search');
  assert.equal(over.ok, false);
  assert.equal(over.status, 429);
  // Free count requests still pass even when the credit budget is spent.
  assert.equal(g.check('shodan', '/shodan/host/count').ok, true);
});

test('rate limit is enforced independent of cost', () => {
  const g = createGovernor(feeds);
  for (let i = 0; i < 3; i += 1) {
    const c = g.check('shodan', '/shodan/host/count'); // free, but rate-counted on record
    assert.equal(c.ok, true);
    g.record('shodan', c.cost);
  }
  assert.equal(g.check('shodan', '/shodan/host/count').ok, false); // 4th within a minute
});

test('credit window resets after creditWindowMs', () => {
  let t = 1000;
  const g = createGovernor(feeds, () => t);
  g.record('shodan', g.check('shodan', '/shodan/host/search').cost);
  g.record('shodan', g.check('shodan', '/shodan/host/search').cost);
  assert.equal(g.check('shodan', '/shodan/host/search').ok, false);
  t += 1001; // window elapses
  assert.equal(g.check('shodan', '/shodan/host/search').ok, true);
});
