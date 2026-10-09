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

test('a rate refusal says when the minute has room again', () => {
  let t = 1_000_000;
  const g = createGovernor(feeds, () => t);
  for (let i = 0; i < 3; i += 1) {
    g.record('shodan', 0);
    t += 10_000;
  }
  // Requests at 0 s, 10 s, 20 s; now 30 s: the first leaves the minute at 60 s.
  const v = g.check('shodan', '/shodan/host/count');
  assert.equal(v.ok, false);
  assert.equal(v.retryAfterMs, 30_001);
  t += v.retryAfterMs;
  assert.equal(g.check('shodan', '/shodan/host/count').ok, true);
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

test('acquire counts a request at once, so concurrent callers cannot all slip through', () => {
  const g = createGovernor([
    {
      id: 'll2',
      governor: { ratePerMinute: 3, creditBudget: 12, creditWindowMs: 3_600_000 },
    },
  ]);
  const verdicts = Array.from({ length: 20 }, () => g.acquire('ll2', '/2.3.0/launches/'));
  assert.equal(verdicts.filter((v) => v.ok).length, 3);
  assert.equal(g.usage('ll2').credits, 3);
  // A failed upstream request gives its reservation back.
  g.refund('ll2', verdicts[0]);
  assert.equal(g.usage('ll2').credits, 2);
  assert.equal(g.usage('ll2').reqLastMinute, 2);
  assert.equal(g.acquire('ll2', '/2.3.0/launches/').ok, true);
  // Ungoverned feeds are always allowed and never counted.
  assert.deepEqual(g.acquire('free', '/x'), { ok: true, cost: 0 });
});
