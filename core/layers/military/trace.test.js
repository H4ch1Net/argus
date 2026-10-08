import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tracePath, traceToFixes, fetchTraceFixes } from './trace.js';
import { parseMilitary } from './parse.js';

const T0 = 1_700_000_000; // seconds
const trace = {
  icao: 'ae1234',
  timestamp: T0,
  trace: [
    [
      0,
      38.9,
      -77.1,
      'ground',
      0,
      90,
      0,
      null,
      { r: '05-5140', ownOp: 'Somebody' },
      'adsb_icao',
      null,
    ],
    [60, 38.95, -77.0, null, 150, 90, 0, null, null, 'adsb_icao', null],
    [120, 39.0, -76.9, 5000, 250, 90, 0, 1500, null, 'adsb_icao', 5200],
    [180, 39.1, -76.8, 10000, 300, 90, 0, 1500, null, 'adsb_icao', null],
    [240, 39.2, -76.7, null, 300, 90, 0, 0, null, 'adsb_icao', null],
    [300, 'x', -76.6, 12000],
    [360, 95, -76.6, 12000],
    'junk',
    [420, 39.3, -76.6, 12000, 300, 90, 0, 0, null, 'adsb_icao', null],
  ],
};

test('trace file paths: last two hex digits, tilde kept, bad input refused', () => {
  assert.equal(tracePath('AE1234'), '/data/traces/34/trace_full_ae1234.json');
  assert.equal(tracePath('~43c001'), '/data/traces/01/trace_full_~43c001.json');
  assert.equal(tracePath('ae123'), null);
  assert.equal(tracePath('../../x'), null);
  assert.equal(tracePath(null), null);
});

test('trace -> fixes: ms times, metres, geometric preferred, gaps carried', () => {
  const fixes = traceToFixes(trace);
  assert.deepEqual(
    fixes.map((f) => f.t),
    [0, 60, 120, 180, 240, 420].map((s) => (T0 + s) * 1000),
  );
  assert.deepEqual(Object.keys(fixes[0]).sort(), [
    'altitude',
    'latitude',
    'longitude',
    't',
  ]);
  assert.equal(fixes[0].altitude, 0); // 'ground'
  assert.equal(fixes[1].altitude, 0); // null: carries the previous altitude
  assert.ok(Math.abs(fixes[2].altitude - 5200 * 0.3048) < 1e-9); // geometric preferred
  assert.ok(Math.abs(fixes[3].altitude - 10000 * 0.3048) < 1e-9); // else barometric
  assert.equal(fixes[4].altitude, fixes[3].altitude);
  assert.equal(fixes[0].longitude, -77.1);
});

test('only points older than the oldest live fix are kept', () => {
  const before = (T0 + 180) * 1000;
  const fixes = traceToFixes(trace, { before });
  assert.equal(fixes.length, 3);
  assert.ok(fixes.every((f) => f.t < before));
});

test('stride thinning keeps the newest point and the order', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => [
    i * 10,
    40 + i / 1000,
    -100,
    30000,
  ]);
  const fixes = traceToFixes({ timestamp: T0, trace: rows }, { maxPoints: 400 });
  assert.ok(fixes.length <= 400 && fixes.length >= 300, `${fixes.length}`);
  assert.equal(fixes.at(-1).t, (T0 + 9990) * 1000);
  for (let i = 1; i < fixes.length; i++) assert.ok(fixes[i].t > fixes[i - 1].t);
  assert.equal(traceToFixes({ timestamp: T0, trace: rows }, { maxPoints: 1 }).length, 1);
});

test('leading altitude gaps take the first known one; wrong aircraft yields nothing', () => {
  const fixes = traceToFixes({
    timestamp: T0,
    trace: [
      [0, 1, 1, null],
      [10, 1, 1.1, 20000],
    ],
  });
  assert.equal(fixes[0].altitude, 20000 * 0.3048);
  assert.deepEqual(traceToFixes(trace, { hex: 'abcdef' }), []);
  assert.equal(traceToFixes(trace, { hex: 'AE1234' }).length, 6);
  assert.deepEqual(traceToFixes(null), []);
  assert.deepEqual(traceToFixes({ timestamp: 'x', trace: [[0, 1, 1, 0]] }), []);
});

test('fetch through the proxy; a missing trace is empty, other errors surface', async () => {
  const asked = [];
  const client = {
    async getJson(feed, path) {
      asked.push(`${feed}${path}`);
      return trace;
    },
  };
  const fixes = await fetchTraceFixes({
    proxyClient: client,
    hex: 'ae1234',
    before: Infinity,
  });
  assert.equal(fixes.length, 6);
  assert.deepEqual(asked, ['adsblol-trace/data/traces/34/trace_full_ae1234.json']);
  const missing = {
    getJson: async () => {
      const e = new Error('proxy adsblol-trace responded 404');
      e.status = 404;
      throw e;
    },
  };
  assert.deepEqual(await fetchTraceFixes({ proxyClient: missing, hex: 'ae1234' }), []);
  assert.deepEqual(await fetchTraceFixes({ proxyClient: client, hex: 'nope' }), []);
  const down = { getJson: async () => Promise.reject(new Error('offline')) };
  await assert.rejects(fetchTraceFixes({ proxyClient: down, hex: 'ae1234' }), /offline/);
});

test('military entities carry the adsb.lol address for their trace file', () => {
  const out = parseMilitary({
    ac: [
      { hex: 'AE1234', lat: 1, lon: 1 },
      { hex: '~43c001', lat: 2, lon: 2 },
    ],
  });
  assert.deepEqual(
    out.map((n) => [n.id, n.meta.hex, tracePath(n.meta.hex)]),
    [
      ['ae1234', 'ae1234', '/data/traces/34/trace_full_ae1234.json'],
      ['43c001', '~43c001', '/data/traces/01/trace_full_~43c001.json'],
    ],
  );
});
