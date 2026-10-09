import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SELF_ICON,
  SELF_ICONS,
  SELF_ICON_IDS,
  drawSelfIcon,
  isSelfIcon,
  turnsWithHeading,
} from './selfIcons.js';
import { SETTINGS_SCHEMA, validateSettings } from '../settings/store.js';

test('the icon list: unique ids, short uppercase labels, the default first', () => {
  assert.ok(SELF_ICONS.length >= 7);
  assert.equal(new Set(SELF_ICON_IDS).size, SELF_ICON_IDS.length);
  assert.equal(SELF_ICON_IDS[0], DEFAULT_SELF_ICON);
  for (const i of SELF_ICONS) {
    assert.match(i.id, /^[a-z]+$/);
    assert.equal(i.label, i.label.toUpperCase());
    assert.ok(i.label.length <= 10, i.label);
  }
  for (const id of ['chevron', 'triangle', 'diamond', 'car', 'crosshair', 'dot'])
    assert.ok(isSelfIcon(id), id);
  assert.equal(isSelfIcon('nope'), false);
});

test('the selfIcon setting allows exactly these icons, chevron by default', () => {
  assert.deepEqual(SETTINGS_SCHEMA.selfIcon.values, [...SELF_ICON_IDS]);
  assert.equal(SETTINGS_SCHEMA.selfIcon.def, DEFAULT_SELF_ICON);
  assert.equal(validateSettings({ selfIcon: 'car' }).selfIcon, 'car');
  assert.equal(validateSettings({ selfIcon: 'tank' }).selfIcon, DEFAULT_SELF_ICON);
});

test('which icons turn with the heading', () => {
  assert.equal(turnsWithHeading('chevron'), true);
  assert.equal(turnsWithHeading('car'), true);
  assert.equal(turnsWithHeading('dot'), true); // its caret
  assert.equal(turnsWithHeading('crosshair'), false);
  assert.equal(turnsWithHeading('nope'), false);
});

// A 2D context that records what is drawn, so every icon's code path runs.
function recorder() {
  const calls = [];
  const g = new Proxy(
    {},
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === 'createLinearGradient')
          return () => ({ addColorStop: (o, c) => calls.push(['stop', o, c]) });
        return (...args) => calls.push([prop, ...args]);
      },
      set(target, prop, value) {
        target[prop] = value;
        calls.push(['set', prop, value]);
        return true;
      },
    },
  );
  return { g, calls };
}

test('every icon draws, with and without its heading mark, inside its box', () => {
  for (const { id } of SELF_ICONS) {
    for (const cue of [true, false]) {
      const { g, calls } = recorder();
      drawSelfIcon(g, id, 64, { cue });
      const paints = calls.filter(([k]) => ['fill', 'stroke', 'fillRect'].includes(k));
      assert.ok(paints.length >= 2, `${id} cue=${cue} paints`);
      assert.deepEqual(calls[0], ['save']);
      assert.deepEqual(calls.at(-1), ['restore']);
      // Coordinates stay inside the nominal 32 px box (scaled by the context).
      for (const [k, x, y] of calls)
        if (k === 'moveTo' || k === 'lineTo') {
          assert.ok(x >= 0 && x <= 32 && y >= 0 && y <= 32, `${id} ${k} ${x},${y}`);
        }
    }
  }
});

test('the heading mark only appears when asked for', () => {
  const count = (id, cue) => {
    const { g, calls } = recorder();
    drawSelfIcon(g, id, 32, { cue });
    return calls.length;
  };
  assert.ok(count('dot', true) > count('dot', false));
  assert.ok(count('diamond', true) > count('diamond', false));
  assert.equal(count('chevron', true), count('chevron', false));
});
