import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ICON_LAYERS,
  ICON_SETTINGS_SCHEMA,
  LAYER_SIZES,
  ZOOM,
  bindIconSettings,
  closeRegime,
  createIconPolicy,
  curveAt,
  defaultVariant,
  glyphDensity,
  iconLook,
  isIconKey,
  prefsFromSettings,
  sizeKey,
  stepSize,
  variantKey,
  variantOf,
  zoomCurve,
} from './iconPrefs.js';
import { GLYPH_NAMES } from './glyphs.js';
import { LAYER_INK } from './palette.js';
import {
  SETTINGS_SCHEMA,
  createSettingsStore,
  defaultSettings,
  validateSettings,
} from '../settings/store.js';
import { SURVEILLANCE_KINDS } from '../layers/surveillance/kinds.js';

// The Layer SDK's default curve for point layers (core/layers/sdk/renderers.js).
const POINT = { near: 1.5e5, nearValue: 1, far: 1.6e7, farValue: 0.5 };
// The simulated traffic's own curve (core/layers/simtraffic/renderer.js).
const SIM = { near: 400, nearValue: 1, far: 8000, farValue: 0.45 };

const memory = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
};

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('curveAt follows Cesium: clamped outside, t^0.2 on squared distance', () => {
  assert.equal(curveAt(null, 123), 1);
  assert.equal(curveAt(POINT, 10), 1);
  assert.equal(curveAt(POINT, 1.5e5), 1);
  assert.equal(curveAt(POINT, 5e7), 0.5);
  const d = 2e6;
  const t = ((d * d - 1.5e5 ** 2) / (1.6e7 ** 2 - 1.5e5 ** 2)) ** 0.2;
  assert.ok(near(curveAt(POINT, d), 1 - 0.5 * t));
});

test('scale with zoom: clearly bigger at street level and in the car, as before from 8 km out', () => {
  const z = zoomCurve(POINT);
  assert.equal(z.near, ZOOM.nearM);
  assert.equal(z.far, ZOOM.farM);
  assert.ok(near(curveAt(z, 100), 3));
  // The owner's screenshots: camera 150 to 400 m up.
  for (const d of [150, 250, 400]) {
    const s = curveAt(z, d);
    assert.ok(s >= 2.2 && s <= 2.8, `${d} m: ${s}`);
  }
  assert.ok(curveAt(z, 1000) > 1.8);
  // The car's follow view: 1.8 to 6.5 km up.
  assert.ok(curveAt(z, 2000) > 1.7);
  assert.ok(curveAt(z, 4000) > 1.35);
  // From 8 km out the close-up curve is the layer's own value: no bigger.
  for (const d of [8000, 2e4, 1e5, 1.5e5])
    assert.ok(near(curveAt(z, d), curveAt(POINT, d)));
});

test('the curve swap happens where both curves agree (no jump on screen)', () => {
  // Below enterM the close-up curve applies. Every icon in view is at least
  // the camera height away, and up to 150 km both curves read the same.
  const z = zoomCurve(POINT);
  for (const d of [ZOOM.enterM, ZOOM.leaveM, 8e4, 1.5e5]) {
    assert.ok(near(curveAt(z, d), curveAt(POINT, d)), `${d}`);
  }
});

test('the regime switches with hysteresis', () => {
  assert.equal(closeRegime(ZOOM.enterM - 1, false), true);
  assert.equal(closeRegime(ZOOM.enterM + 1, false), false);
  assert.equal(closeRegime(ZOOM.enterM + 1, true), true); // stays close until leaveM
  assert.equal(closeRegime(ZOOM.leaveM + 1, true), false);
});

test('simulated traffic grows near the ground and ends at its own far value', () => {
  const z = zoomCurve(SIM);
  assert.ok(curveAt(z, 300) > 2);
  assert.ok(curveAt(z, 300) > 2 * curveAt(SIM, 300));
  assert.ok(near(z.farValue, curveAt(SIM, ZOOM.farM)));
  assert.ok(curveAt(z, 8000) <= curveAt(SIM, 5000));
});

test('iconLook: fixed keeps the layer curve, zoom swaps near the ground, sizes multiply', () => {
  const prefs = {
    scaling: 'fixed',
    size: 150,
    sizes: { signals: 200 },
    variants: {},
    close: true,
  };
  const fixed = iconLook(prefs, 'signals', POINT);
  assert.equal(fixed.curve, POINT);
  assert.equal(fixed.size, 3);
  assert.equal(fixed.maxScale, 3);
  const zoomFar = iconLook({ ...prefs, scaling: 'zoom', close: false }, 'signals', POINT);
  assert.equal(zoomFar.curve, POINT);
  // The same canvases in both regimes: the swap never changes images.
  assert.equal(zoomFar.maxScale, 3 * ZOOM.max);
  const zoomNear = iconLook({ ...prefs, scaling: 'zoom' }, 'signals', POINT);
  assert.deepEqual(zoomNear.curve, zoomCurve(POINT));
  assert.equal(zoomNear.maxScale, 3 * ZOOM.max);
  // Unknown layers draw at the global size with no variant.
  const other = iconLook({ ...prefs, sizes: {} }, 'nolayer', POINT);
  assert.equal(other.size, 1.5);
  assert.equal(other.variant, null);
  assert.equal(other.glyphName('node'), 'node');
});

test('variants map glyph names and fall back to the default', () => {
  assert.equal(defaultVariant('signals'), 'color');
  assert.equal(defaultVariant('simtraffic'), 'car');
  assert.equal(defaultVariant('quakes'), null);
  const p = { scaling: 'zoom', size: 100, sizes: {}, variants: { signals: 'arm' } };
  assert.equal(iconLook(p, 'signals', POINT).glyphName('signal'), 'signal-arm');
  assert.equal(iconLook(p, 'simtraffic', SIM).glyphName('vehicle'), 'car-top');
  assert.equal(variantOf('signals', 'bogus').id, 'color');
  const head = iconLook({ ...p, variants: { signals: 'head' } }, 'signals', POINT);
  assert.equal(head.glyphName('signal'), 'signal');
});

test('every variant draws a glyph that exists, for every glyph its layer uses', () => {
  const names = new Set(GLYPH_NAMES);
  for (const l of ICON_LAYERS) {
    for (const v of l.variants ?? []) {
      for (const [from, to] of Object.entries(v.glyphs)) {
        assert.ok(names.has(from), `${l.key}/${v.id}: ${from}`);
        assert.ok(names.has(to), `${l.key}/${v.id}: ${to}`);
      }
    }
  }
  // Each surveillance family covers every kind's glyph.
  const surv = ICON_LAYERS.find((l) => l.key === 'surveillance');
  for (const v of surv.variants.filter((x) => x.id !== 'device'))
    for (const k of Object.values(SURVEILLANCE_KINDS))
      assert.ok(v.glyphs[k.glyph], `${v.id} lacks ${k.glyph}`);
});

test('every icon layer is registered by main.js and has an ink', () => {
  const src = fs.readFileSync(new URL('../../main.js', import.meta.url), 'utf8');
  for (const l of ICON_LAYERS) {
    assert.ok(src.includes(`key: '${l.key}',`), `${l.key} not registered`);
    assert.ok(LAYER_INK[l.key], `${l.key} has no ink`);
  }
});

test('glyph density steps up for icons that grow', () => {
  assert.equal(glyphDensity(11), 2);
  assert.equal(glyphDensity(20), 2);
  assert.equal(glyphDensity(28), 3);
  assert.equal(glyphDensity(45), 3);
  assert.equal(glyphDensity(60), 4);
});

test('size steps clamp to the allowed sizes', () => {
  assert.equal(stepSize(100, 1), 125);
  assert.equal(stepSize(100, -1), 75);
  assert.equal(stepSize(LAYER_SIZES[0], -1), LAYER_SIZES[0]);
  assert.equal(stepSize(300, 1), 300);
  assert.equal(stepSize(999, 1), 125); // unknown: from 100
});

test('the icon settings are in the store schema and validated', () => {
  for (const k of Object.keys(ICON_SETTINGS_SCHEMA)) assert.ok(SETTINGS_SCHEMA[k], k);
  assert.ok(isIconKey('iconScaling'));
  assert.ok(isIconKey(sizeKey('signals')));
  assert.ok(isIconKey(variantKey('signals')));
  assert.ok(!isIconKey('merge'));
  assert.equal(isIconKey(variantKey('quakes')), false); // no variants there
  const d = defaultSettings();
  assert.equal(d.iconScaling, 'zoom');
  assert.equal(d.iconSize, 100);
  assert.equal(d[sizeKey('simtraffic')], 100);
  assert.equal(d[variantKey('signals')], 'color');
  const v = validateSettings({
    iconScaling: 'huge',
    iconSize: 150,
    [sizeKey('signals')]: 999,
    [sizeKey('ships')]: 250,
    [variantKey('signals')]: 'nope',
    [variantKey('simtraffic')]: 'arrow',
  });
  assert.equal(v.iconScaling, 'zoom');
  assert.equal(v.iconSize, 150);
  assert.equal(v[sizeKey('signals')], 100);
  assert.equal(v[sizeKey('ships')], 250);
  assert.equal(v[variantKey('signals')], 'color');
  assert.equal(v[variantKey('simtraffic')], 'arrow');
});

test('icon settings survive export and import, and reset', () => {
  const a = createSettingsStore(memory());
  a.set('iconScaling', 'fixed');
  a.set(sizeKey('signals'), 250);
  a.set(variantKey('surveillance'), 'badge');
  const b = createSettingsStore(memory());
  assert.equal(b.import(a.export()), true);
  assert.equal(b.get('iconScaling'), 'fixed');
  assert.equal(b.get(sizeKey('signals')), 250);
  assert.equal(b.get(variantKey('surveillance')), 'badge');
  b.reset();
  assert.equal(b.get('iconScaling'), 'zoom');
  assert.equal(b.get(sizeKey('signals')), 100);
  assert.equal(b.get(variantKey('surveillance')), 'device');
});

test('the policy bumps its version only on a real change', () => {
  let asks = 0;
  const p = createIconPolicy(() => (asks += 1));
  assert.equal(p.apply(defaultSettings()), true);
  const v0 = p.version;
  assert.equal(p.apply(defaultSettings()), false);
  assert.equal(p.version, v0);
  // Zoom mode: coming down past enterM switches to the close-up curve.
  assert.equal(p.observe(5e6), false);
  assert.equal(p.observe(ZOOM.enterM - 10), true);
  assert.equal(p.close, true);
  assert.equal(p.version, v0 + 1);
  assert.equal(p.observe(ZOOM.enterM + 10), false); // hysteresis
  assert.equal(p.observe(Number.NaN), false);
  // Fixed mode: the regime still tracks, but nothing restyles for it.
  p.apply({ ...defaultSettings(), iconScaling: 'fixed' });
  const v1 = p.version;
  p.observe(ZOOM.leaveM + 10);
  assert.equal(p.version, v1);
  assert.equal(p.look('signals', POINT).curve, POINT);
  assert.ok(asks >= 3);
});

test('bindIconSettings follows the store and ignores other keys', () => {
  const s = createSettingsStore(memory());
  const p = createIconPolicy();
  const off = bindIconSettings(p, s);
  const v0 = p.version;
  s.set('units', 'imperial');
  assert.equal(p.version, v0);
  s.set(sizeKey('signals'), 150);
  assert.equal(p.version, v0 + 1);
  assert.equal(p.look('signals', POINT).size, 1.5);
  s.set(variantKey('signals'), 'node');
  assert.equal(p.look('signals', POINT).glyphName('signal'), 'signal-node');
  off();
  s.set(sizeKey('signals'), 300);
  assert.equal(p.prefs.sizes.signals, 150);
  assert.deepEqual(prefsFromSettings(null).scaling, 'zoom');
});
