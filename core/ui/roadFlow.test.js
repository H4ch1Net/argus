import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoadFlow } from './roadFlow.js';
import { createInternetDbExtras, createAsLookupExtras } from '../osint/cardExtras.js';

const segment = (current, free, closed = false) => ({
  flowSegmentData: {
    frc: 'FRC2',
    currentSpeed: current,
    freeFlowSpeed: free,
    roadClosure: closed,
    coordinates: {
      coordinate: [
        { latitude: 1, longitude: 1 },
        { latitude: 1.001, longitude: 1 },
      ],
    },
  },
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the flow readout: off until enabled, one request per place, coloured by level', async () => {
  let t = 1_000_000;
  let view = { lat: 51.5, lon: -0.12, heightM: 3000 };
  const asked = [];
  const states = [];
  const flow = createRoadFlow({
    now: () => t,
    getView: () => view,
    fetchFlow: async (lat, lon) => {
      asked.push([lat, lon]);
      return segment(20, 50);
    },
    onChange: (s) => states.push(s),
  });
  flow.viewChanged();
  await wait(450);
  assert.equal(asked.length, 0, 'nothing while off');
  flow.setEnabled(true);
  await wait(20);
  assert.equal(asked.length, 1);
  assert.equal(states.at(-1).text, '20 / 50 KM/H (40%)');
  assert.equal(states.at(-1).level, 'jam');
  // The same place again (a few metres off): the answer is reused.
  view = { lat: 51.50005, lon: -0.12, heightM: 3000 };
  flow.viewChanged();
  await wait(450);
  assert.equal(asked.length, 1);
  // Too high: no request, a hint instead.
  view = { lat: 40, lon: 0, heightM: 900_000 };
  flow.viewChanged();
  await wait(450);
  assert.equal(states.at(-1).text, 'ZOOM IN');
  assert.equal(asked.length, 1);
  flow.setEnabled(false);
  assert.equal(states.at(-1), null);
});

test('the flow readout says when the budget is spent', async () => {
  const states = [];
  const flow = createRoadFlow({
    getView: () => ({ lat: 1, lon: 1, heightM: 100 }),
    fetchFlow: async () => {
      throw Object.assign(new Error('429'), { status: 429 });
    },
    onChange: (s) => states.push(s),
  });
  flow.setEnabled(true);
  await wait(20);
  assert.equal(states.at(-1).text, 'BUDGET SPENT');
});

test('InternetDB rows on any card naming an IP, looked up once', async () => {
  const calls = [];
  const cache = new Map();
  const lookup = async (ip) => {
    calls.push(ip);
    const v =
      ip === '203.0.113.7'
        ? null
        : { ip, ports: [443], cpes: [], hostnames: [], tags: [], vulns: [] };
    cache.set(ip, v);
    return v;
  };
  lookup.peek = (ip) => (cache.has(ip) ? cache.get(ip) : undefined);
  const x = createInternetDbExtras({ lookup });
  let refreshed = 0;
  const ctx = { refresh: () => (refreshed += 1) };
  const n = { meta: { ip: '198.51.100.9' } };
  assert.deepEqual(x.rows('shodan', n), []);
  await x.onSelect('shodan', n, ctx);
  await x.onSelect('shodan', n, ctx);
  assert.deepEqual(calls, ['198.51.100.9']);
  assert.ok(refreshed >= 2);
  assert.equal(Object.fromEntries(x.rows('shodan', n))['Open ports'], '443');
  await x.onSelect('shodan', { meta: { ip: '203.0.113.7' } }, ctx);
  assert.deepEqual(x.rows('shodan', { meta: { ip: '203.0.113.7' } }), [
    ['InternetDB', 'nothing indexed for this IP'],
  ]);
  assert.deepEqual(x.rows('flights', { meta: { callsign: 'X' } }), []);
});

test('LOOK UP AS on a BGP card correlates the AS and selects the plotted result', async () => {
  const plotted = [];
  const selected = [];
  const x = createAsLookupExtras({
    getCorrelate: () => async (asset) => ({
      id: `corr:${asset.value}`,
      position: { longitude: 1, latitude: 2 },
    }),
    plot: (r) => (plotted.push(r), { id: r.id }),
    select: (e) => selected.push(e),
  });
  const ctx = { refresh: () => {} };
  const rec = { key: 'bgp', normalized: { meta: { asn: 3333 } } };
  const [action] = x.actions({}, rec, ctx);
  assert.equal(action.label, 'LOOK UP AS');
  await action.onClick();
  assert.equal(plotted[0].id, 'corr:AS3333');
  assert.deepEqual(selected, [{ id: 'corr:AS3333' }]);
  assert.deepEqual(x.actions({}, { key: 'flights', normalized: { meta: {} } }, ctx), []);
});
