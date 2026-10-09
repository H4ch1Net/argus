import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSettingsStore,
  defaultSettings,
  validateSettings,
  profileOverrides,
  formatDistance,
  formatAltitude,
  formatSpeed,
  SETTINGS_KEY,
} from './store.js';

const memory = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    raw: m,
  };
};

test('invalid stored values fall back to their defaults', () => {
  const s = validateSettings({ tier: 'ultra', fps: 30, units: 'imperial', junk: 1 });
  assert.equal(s.tier, 'auto');
  assert.equal(s.fps, 30);
  assert.equal(s.units, 'imperial');
  assert.equal('junk' in s, false);
  assert.deepEqual(validateSettings(null), defaultSettings());
});

test('the store persists, notifies and survives broken storage', () => {
  const st = memory();
  const a = createSettingsStore(st);
  const seen = [];
  a.subscribe((k, v) => seen.push([k, v]));
  assert.equal(a.set('units', 'nautical'), 'nautical');
  assert.equal(a.set('fps', 999), 'auto');
  assert.deepEqual(seen, [['units', 'nautical']]);
  assert.equal(createSettingsStore(st).get('units'), 'nautical');
  st.raw.set(SETTINGS_KEY, '{not json');
  assert.equal(createSettingsStore(st).get('units'), 'metric');
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('full');
    },
  };
  const b = createSettingsStore(broken);
  assert.equal(b.set('clock', 'local'), 'local');
});

test('export and import round-trip; foreign files are refused', () => {
  const a = createSettingsStore(memory());
  a.set('coords', 'mgrs');
  const b = createSettingsStore(memory());
  assert.equal(b.import(a.export()), true);
  assert.equal(b.get('coords'), 'mgrs');
  assert.equal(b.import('{"v":2}'), false);
  assert.equal(b.import('nope'), false);
});

test('profile overrides leave auto values to the tier', () => {
  assert.deepEqual(profileOverrides(defaultSettings()), {});
  assert.deepEqual(
    profileOverrides(
      { ...defaultSettings(), fps: 60, resolution: 1.5, detail: 'high' },
      3,
    ),
    {
      targetFrameRate: 60,
      resolutionScale: 0.5, // 1.5 rendered px per CSS px on a 3x panel
      maximumScreenSpaceError: 1.33,
    },
  );
});

test('merge nearby is on by default and takes only on or off', () => {
  assert.equal(defaultSettings().merge, true);
  assert.equal(validateSettings({ merge: false }).merge, false);
  assert.equal(validateSettings({ merge: 'no' }).merge, true);
});

test('units format distances, altitudes and speeds', () => {
  assert.equal(formatDistance(850), '850 M');
  assert.equal(formatDistance(3200), '3.2 KM');
  assert.equal(formatDistance(3200, 'imperial'), '2.0 MI');
  assert.equal(formatDistance(100, 'imperial'), '328 FT');
  assert.equal(formatDistance(3704, 'nautical'), '2.0 NM');
  assert.equal(formatAltitude(10_000, 'imperial'), '32,808 FT');
  assert.equal(formatAltitude(1500), '1,500 M');
  assert.equal(formatSpeed(100, 'nautical'), '194 KT');
  assert.equal(formatSpeed(10), '36 KM/H');
  assert.equal(formatDistance(NaN), '--');
});
