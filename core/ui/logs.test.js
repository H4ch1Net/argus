import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogStore, formatLine, isFailureNotice } from './logs.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('repeats of one source and title fold into a count, newest first', () => {
  let now = 1_000;
  const logs = createLogStore({ now: () => now });
  logs.add({ level: 'error', source: 'chp', title: 'CHP FEED ERROR', body: 'proxy 502' });
  now = 2_000;
  logs.add({ level: 'warn', source: 'gdelt', title: 'NEWS STALE' });
  now = 3_000;
  const again = logs.add({
    level: 'error',
    source: 'chp',
    title: 'CHP FEED ERROR',
    body: 'timed out',
  });
  assert.equal(again.count, 2);
  const list = logs.list();
  assert.deepEqual(
    list.map((e) => [e.source, e.count]),
    [
      ['chp', 2],
      ['gdelt', 1],
    ],
  );
  assert.equal(list[0].first, 1_000);
  assert.equal(list[0].t, 3_000);
  assert.equal(list[0].body, 'timed out', 'the latest detail');
  assert.deepEqual(
    logs.list({ level: 'warn' }).map((e) => e.title),
    ['NEWS STALE'],
  );
  // Copies: changing one does not change the store.
  list[0].title = 'x';
  assert.equal(logs.list()[0].title, 'CHP FEED ERROR');
});

test('a ring: the oldest go past the capacity; clear empties it', () => {
  const logs = createLogStore({ capacity: 3 });
  for (let i = 0; i < 5; i += 1) logs.add({ title: `T${i}` });
  assert.deepEqual(
    logs.list().map((e) => e.title),
    ['T4', 'T3', 'T2'],
  );
  logs.add({ title: 'T2' }); // a repeat moves to the front, nothing dropped
  assert.deepEqual(
    logs.list().map((e) => e.title),
    ['T2', 'T4', 'T3'],
  );
  logs.clear();
  assert.equal(logs.size, 0);
});

test('levels, text and sizes are sanitized', () => {
  const logs = createLogStore();
  const e = logs.add({
    level: 'fatal',
    source: 'x'.repeat(99),
    title: 'a\u0000b\n c',
    body: 'y'.repeat(2000),
  });
  assert.equal(e.level, 'info');
  assert.equal(e.source.length, 40);
  assert.equal(e.title, 'a b c');
  assert.equal(e.body.length, 600);
  assert.equal(logs.add({}).title, 'UNTITLED');
});

test('counts since a time, and listeners hear once per burst', async () => {
  let now = 0;
  const logs = createLogStore({ now: () => now });
  let calls = 0;
  const off = logs.subscribe(() => (calls += 1));
  logs.add({ level: 'error', title: 'A' });
  logs.add({ level: 'warn', title: 'B' });
  now = 10;
  logs.add({ level: 'info', title: 'C' });
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(logs.counts(), { info: 1, warn: 1, error: 1, total: 3 });
  assert.deepEqual(logs.counts({ since: 5 }), { info: 1, warn: 0, error: 0, total: 1 });
  off();
  logs.add({ title: 'D' });
  await tick();
  assert.equal(calls, 1);
  const seq = logs.seq;
  logs.add({ title: 'D' });
  assert.equal(logs.seq, seq + 1);
});

test('plain-text export, oldest first', () => {
  let now = Date.parse('2026-10-09T06:00:12Z');
  const logs = createLogStore({ now: () => now });
  logs.add({
    level: 'warn',
    source: 'chp',
    title: 'CHP INCIDENTS STALE',
    body: 'served 4 min old',
  });
  now += 1000;
  logs.add({ level: 'error', title: 'NEWS FEED ERROR' });
  logs.add({ level: 'error', title: 'NEWS FEED ERROR' });
  assert.equal(
    logs.toText(),
    '2026-10-09 06:00:12Z WARN [chp] CHP INCIDENTS STALE: served 4 min old\n' +
      '2026-10-09 06:00:13Z ERR  NEWS FEED ERROR (x2)',
  );
  assert.match(formatLine({ t: 0, level: 'info', title: 'X', count: 1 }), /^1970-01-01/);
});

test('failure notices go to the log; prompts and results stay notices', () => {
  for (const n of [
    { title: 'TRACE FAILED', body: 'x' },
    { title: 'IMAGERY SEARCH FAILED' },
    { title: 'NO STILL', body: 'proxy caltrans-img responded 502' },
    { title: 'ROUTE', body: 'proxy osrm responded 504: upstream timed out after 15 s' },
    { title: 'TRACE UNAVAILABLE', body: 'Needs the live proxy.' },
    { title: 'KEY NOT SAVED', body: 'The proxy did not answer.' },
    { title: 'CHP FEED ERROR' },
    { title: 'Anything', kind: 'failure' },
  ])
    assert.equal(isFailureNotice(n), true, n.title);
  for (const n of [
    { title: 'NO TARGET', body: 'Select a contact first.' },
    { title: 'ROUTE', body: 'Set both A and B first.' },
    { title: 'LINK COPIED', body: 'This view is in the clipboard.' },
    { title: 'LOCATION DENIED', body: 'Allow location for Argus.' },
    { title: 'NO PROXY REACHABLE', body: 'Run npm start', level: 'critical' },
    { title: 'TRACE FAILED', kind: 'notice' },
    null,
  ])
    assert.equal(isFailureNotice(n), false, n?.title);
});
