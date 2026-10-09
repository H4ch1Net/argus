import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachSelfCompass } from './selfCompass.js';

function fakeWindow({ absolute = true } = {}) {
  const listeners = new Map();
  const win = {
    addEventListener: (t, fn) => listeners.set(t, fn),
    removeEventListener: (t) => listeners.delete(t),
    listeners,
  };
  if (absolute) win.ondeviceorientationabsolute = null;
  return win;
}

function fakeSelf() {
  const watchers = new Set();
  const sp = {
    headings: [],
    watch(fn) {
      watchers.add(fn);
      fn({ sensing: false });
      return () => watchers.delete(fn);
    },
    setCompass: (h) => sp.headings.push(h),
    sense(on) {
      for (const fn of watchers) fn({ sensing: on });
    },
  };
  return sp;
}

test('the compass is read only while the position sensors are open', () => {
  const win = fakeWindow();
  const sp = fakeSelf();
  const detach = attachSelfCompass(sp, { win });
  assert.equal(win.listeners.size, 0);
  sp.sense(true);
  assert.ok(win.listeners.has('deviceorientationabsolute'));
  win.listeners.get('deviceorientationabsolute')({ alpha: 90, beta: 0, gamma: 0 });
  assert.deepEqual(sp.headings, [270]); // alpha is counter-clockwise
  sp.sense(false);
  assert.equal(win.listeners.size, 0);
  assert.equal(sp.headings.at(-1), null); // the heading is dropped with it
  detach();
});

test('a relative reading (no north reference) is ignored; iOS compass heading is used', () => {
  const win = fakeWindow({ absolute: false });
  const sp = fakeSelf();
  attachSelfCompass(sp, { win });
  sp.sense(true);
  const on = win.listeners.get('deviceorientation');
  on({ alpha: 10, beta: 0, gamma: 0, absolute: false });
  assert.deepEqual(sp.headings, []);
  on({ alpha: 10, beta: 0, gamma: 0, webkitCompassHeading: 42 });
  assert.deepEqual(sp.headings, [42]);
  // At most ten readings a second.
  on({ alpha: 10, beta: 0, gamma: 0, webkitCompassHeading: 43 });
  assert.deepEqual(sp.headings, [42]);
});
