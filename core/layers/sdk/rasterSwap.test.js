import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFrameSwapper } from './rasterSwap.js';

function harness() {
  const log = [];
  const stack = []; // bottom -> top: { name, hidden }
  const loaders = new Map();
  let timer = null;
  const swap = createFrameSwapper({
    add(next, below, hidden) {
      const i = below ? stack.findIndex((l) => l.name === below) + 1 : stack.length;
      stack.splice(i, 0, { name: next, hidden });
      log.push(`add ${next}${hidden ? ' hidden' : ''}`);
    },
    reveal(layer) {
      stack.find((l) => l.name === layer).hidden = false;
      log.push(`reveal ${layer}`);
    },
    remove(layer) {
      stack.splice(
        stack.findIndex((l) => l.name === layer),
        1,
      );
      log.push(`remove ${layer}`);
    },
    whenLoaded(layer, done) {
      loaders.set(layer, done);
      return () => loaders.delete(layer);
    },
    setTimeout: (fn) => ((timer = fn), 1),
    clearTimeout: () => (timer = null),
  });
  const visible = () => stack.filter((l) => !l.hidden).map((l) => l.name);
  return { swap, log, stack, loaders, visible, fireTimeout: () => timer?.() };
}

test('the first frame shows at once; later ones swap only when loaded', () => {
  const h = harness();
  h.swap.show('a');
  assert.deepEqual(h.visible(), ['a']);
  h.swap.show('b');
  assert.deepEqual(h.visible(), ['a']); // b loads hidden above a
  assert.equal(h.swap.pending, 'b');
  h.loaders.get('b')();
  assert.deepEqual(h.visible(), ['b']);
  assert.deepEqual(
    h.stack.map((l) => l.name),
    ['b'],
  );
  assert.equal(h.swap.shown, 'b');
  assert.equal(h.loaders.size, 0);
});

test('a frame superseded while loading is dropped, never shown', () => {
  const h = harness();
  h.swap.show('a');
  h.swap.show('b');
  h.swap.show('c');
  assert.ok(h.log.includes('remove b'));
  assert.ok(!h.log.includes('reveal b'));
  assert.deepEqual(h.visible(), ['a']);
  h.loaders.get('c')();
  assert.deepEqual(h.visible(), ['c']);
});

test('a frame that never reports loaded is swapped in after the timeout', () => {
  const h = harness();
  h.swap.show('a');
  h.swap.show('b');
  h.fireTimeout();
  assert.deepEqual(h.visible(), ['b']);
});

test('clear removes the shown and the pending frame', () => {
  const h = harness();
  h.swap.show('a');
  h.swap.show('b');
  h.swap.clear();
  assert.deepEqual(h.stack, []);
  assert.equal(h.swap.shown, null);
  assert.equal(h.loaders.size, 0);
  h.swap.show('c');
  assert.deepEqual(h.visible(), ['c']);
});

test('onShown reports each frame as it reaches the screen, and a synchronous load swaps at once', () => {
  const shownLog = [];
  let offs = 0;
  const swap = createFrameSwapper({
    add() {},
    reveal() {},
    remove() {},
    whenLoaded(_layer, done) {
      done();
      return () => offs++;
    },
    onShown: (l) => shownLog.push(l),
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  swap.show('a');
  swap.show('b');
  assert.deepEqual(shownLog, ['a', 'b']);
  assert.equal(swap.shown, 'b');
  assert.equal(swap.pending, null);
  assert.equal(offs, 1); // the listener was still removed
});
