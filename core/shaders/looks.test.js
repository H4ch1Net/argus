import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SENSOR_MODES,
  SENSOR_LABELS,
  lookSupport,
  bloomUniforms,
  sharpenAmount,
  strength,
} from './looks.js';

test('tiers gate the looks: snow, CRT, sharpen and bloom are desktop-only', () => {
  const full = lookSupport('full');
  assert.deepEqual(full.modes, ['none', 'nvg', 'flir', 'noir', 'snow']);
  assert.ok(full.crt && full.sharpen && full.bloom);
  assert.equal(full.textureScale, 1);
  const phone = lookSupport('balanced');
  assert.ok(phone.modes.includes('noir'));
  assert.equal(phone.modes.includes('snow'), false);
  assert.equal(phone.crt || phone.sharpen || phone.bloom, false);
  assert.ok(phone.textureScale < 1);
  assert.deepEqual(lookSupport('minimal').modes, ['none']);
  for (const m of SENSOR_MODES) assert.ok(SENSOR_LABELS[m]);
});

test('strength accepts toggles and sliders', () => {
  assert.equal(strength(true), 0.5);
  assert.equal(strength(false), 0);
  assert.equal(strength(2), 1);
  assert.equal(strength('x'), 0);
  assert.equal(sharpenAmount(0), 0.1);
  assert.equal(sharpenAmount(1), 2.1);
});

test('bloom is off below the threshold and eased above it', () => {
  assert.deepEqual(bloomUniforms(0), { enabled: false });
  assert.deepEqual(bloomUniforms(0.05), { enabled: false });
  const max = bloomUniforms(1);
  assert.equal(max.enabled, true);
  assert.equal(max.contrast, 87);
  assert.ok(Math.abs(max.sigma - 6.58) < 1e-9);
  const mid = bloomUniforms(0.5);
  assert.ok(mid.contrast < 255 && mid.contrast > 87);
});
