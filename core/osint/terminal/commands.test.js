import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine, parseGoto, createCommands } from './commands.js';

test('parseCommandLine splits name + args, lowercases name', () => {
  assert.deepEqual(parseCommandLine('  Layer bgp ON '), {
    name: 'layer',
    args: ['bgp', 'ON'],
  });
  assert.equal(parseCommandLine('   '), null);
});

test('parseGoto handles comma coords, spaced coords, and places', () => {
  assert.deepEqual(parseGoto(['33.7,-116.3']), {
    kind: 'coords',
    latitude: 33.7,
    longitude: -116.3,
    altitude: undefined,
  });
  assert.deepEqual(parseGoto(['33.7', '-116.3', '5000']), {
    kind: 'coords',
    latitude: 33.7,
    longitude: -116.3,
    altitude: 5000,
  });
  assert.deepEqual(parseGoto(['san', 'francisco']), {
    kind: 'place',
    query: 'san francisco',
  });
});

function fakeCtx(overrides = {}) {
  const calls = [];
  const ctx = {
    listLayers: () => [
      { key: 'flights', on: true },
      { key: 'bgp', on: false },
    ],
    setLayer: (key, action) => {
      calls.push(['setLayer', key, action]);
      return ['flights', 'bgp'].includes(key);
    },
    track: (q) => (q === 'UAL1' ? 'UAL1' : null),
    goto: (dest) => calls.push(['goto', dest]),
    geocode: null,
    query: async () => ({ kind: 'ip', value: '8.8.8.8' }),
    correlate: async () => ({ error: 'no location' }),
    listPresets: () => [{ id: 'sky', label: 'Sky' }],
    applyPreset: (id) => id === 'sky',
    ...overrides,
  };
  return { ctx, calls };
}

test('unknown command is reported', async () => {
  const { ctx } = fakeCtx();
  const out = await createCommands(ctx).run('frobnicate x');
  assert.match(out[0], /unknown command: frobnicate/);
});

test('layer on calls the facade', async () => {
  const { ctx, calls } = fakeCtx();
  const out = await createCommands(ctx).run('layer bgp on');
  assert.deepEqual(out, ['layer bgp on']);
  assert.deepEqual(calls.at(-1), ['setLayer', 'bgp', 'on']);
});

test('layer with unknown id reports it', async () => {
  const { ctx } = fakeCtx();
  const out = await createCommands(ctx).run('layer nope toggle');
  assert.match(out[0], /unknown layer "nope"/);
});

test('goto coords flies the camera', async () => {
  const { ctx, calls } = fakeCtx();
  const out = await createCommands(ctx).run('goto 10,20');
  assert.match(out[0], /flying to 10, 20/);
  assert.deepEqual(calls.at(-1), [
    'goto',
    { latitude: 10, longitude: 20, altitude: undefined },
  ]);
});

test('goto out-of-range coords is rejected', async () => {
  const { ctx } = fakeCtx();
  const out = await createCommands(ctx).run('goto 200,0');
  assert.match(out[0], /out of range/);
});

test('query success and correlate error both report cleanly', async () => {
  const { ctx } = fakeCtx();
  const cmds = createCommands(ctx);
  assert.deepEqual(await cmds.run('query 8.8.8.8'), ['plotted ip 8.8.8.8']);
  assert.deepEqual(await cmds.run('correlate 8.8.8.8'), ['correlate: no location']);
});

test('help lists every command', async () => {
  const { ctx } = fakeCtx();
  const out = await createCommands(ctx).run('help');
  const text = out.join('\n');
  for (const c of ['track', 'layer', 'goto', 'query', 'correlate', 'preset']) {
    assert.match(text, new RegExp(`\\b${c}\\b`));
  }
});
