import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedState, feedLogEntry } from './feedLog.js';
import { createLogStore } from './logs.js';

// Drive a status sequence through feedLogEntry into a real log store.
function run(statuses, label = 'DATA CENTRES', key = 'datacenters') {
  const logs = createLogStore();
  let was;
  for (const s of statuses) {
    const { state, entry } = feedLogEntry(was, s, label, key);
    was = state;
    if (entry) logs.add(entry);
  }
  return logs
    .list()
    .map((e) => `${e.level} ${e.title}${e.count > 1 ? ` x${e.count}` : ''}: ${e.body}`);
}

test('states: busy for 429/5xx and timeouts, error for the rest and missing keys', () => {
  assert.equal(feedState({ state: 'error', status: 504, message: 'x' }), 'busy');
  assert.equal(
    feedState({ state: 'error', message: 'proxy overpass responded 500' }),
    'busy',
  );
  assert.equal(
    feedState({ state: 'error', message: 'upstream timed out after 35 s' }),
    'busy',
  );
  assert.equal(
    feedState({ state: 'error', status: 403, message: 'proxy waze responded 403' }),
    'error',
  );
  assert.equal(
    feedState({
      state: 'error',
      status: 502,
      message:
        'proxy firms responded 502: feed firms not configured: missing FIRMS_MAP_KEY',
    }),
    'error',
  );
  assert.equal(feedState({ state: 'ok', stale: 60 }), 'stale');
  assert.equal(feedState({ state: 'ok' }), 'ok');
  assert.equal(feedState(null), 'off');
});

test('a busy Overpass: one calm line, then BACK only on a real answer', () => {
  const lines = run([
    { state: 'loading' },
    { state: 'error', message: 'proxy overpass responded 500', status: 500 },
    { state: 'error', message: 'proxy overpass responded 504', status: 504 },
    // A broad view reports ok with nothing asked: not a recovery.
    { state: 'ok', count: 0, note: 'zoom in to load', answered: false },
    { state: 'ok', count: 12, answered: true },
  ]);
  assert.deepEqual(lines, [
    'info DATA CENTRES BACK: 12 items.',
    'warn DATA CENTRES SOURCE BUSY: proxy overpass responded 500. Showing what the layer already had; asking again shortly.',
  ]);
});

test('an empty view after a problem says "no items here", never "BACK: 0 items"', () => {
  const lines = run(
    [
      { state: 'ok', count: 40, answered: true },
      { state: 'ok', count: 40, stale: 60, note: 'STALE: the feed is not answering' },
      { state: 'ok', count: 0, answered: true },
    ],
    'FLIGHTS',
    'flights',
  );
  assert.deepEqual(lines, [
    'info FLIGHTS ANSWERING: The source answers again; no items here.',
    'warn FLIGHTS STALE: the feed is not answering',
  ]);
});

test('no line for a layer that just has nothing in view, or for loading', () => {
  assert.deepEqual(
    run([
      { state: 'loading' },
      { state: 'ok', count: 0, answered: true },
      { state: 'ok', count: 0, answered: true },
      { state: 'off' },
    ]),
    [],
  );
});

test('real errors still log every time (folded); switching off forgets the problem', () => {
  const lines = run(
    [
      { state: 'error', status: 403, message: 'proxy waze responded 403' },
      { state: 'error', status: 403, message: 'proxy waze responded 403' },
      { state: 'off' },
      { state: 'ok', count: 3, answered: true },
    ],
    'WAZE',
    'waze',
  );
  assert.deepEqual(lines, ['error WAZE FEED ERROR x2: proxy waze responded 403']);
});
