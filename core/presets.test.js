import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPreset, PRESETS } from './presets.js';

function fakeManager(keys) {
  const state = new Map(keys.map((k) => [k, false]));
  return {
    keys: () => [...state.keys()],
    enable: (k) => state.set(k, true),
    disable: (k) => state.set(k, false),
    enabled: () => [...state.entries()].filter(([, v]) => v).map(([k]) => k),
  };
}

test('applyPreset enables exactly the preset layers', async () => {
  const m = fakeManager(['flights', 'quakes', 'satellites']);
  await applyPreset(m, { layers: ['flights', 'satellites'] });
  assert.deepEqual(m.enabled().sort(), ['flights', 'satellites']);
});

test('applyPreset disables layers not in the preset', async () => {
  const m = fakeManager(['flights', 'quakes', 'satellites']);
  await applyPreset(m, { layers: ['flights', 'quakes'] });
  await applyPreset(m, { layers: ['quakes'] });
  assert.deepEqual(m.enabled(), ['quakes']);
});

test('every preset references known layer keys', () => {
  const known = new Set([
    'flights',
    'quakes',
    'satellites',
    'fires',
    'ships',
    'surveillance',
    'landmarks',
    'cctv',
  ]);
  for (const p of PRESETS) {
    for (const key of p.layers) assert.ok(known.has(key), `${p.id} -> ${key}`);
  }
});
