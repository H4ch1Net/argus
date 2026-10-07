import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKeys } from './keys.js';

const names = (s) => parseKeys(s).map((k) => k.name);

test('printable characters and control keys', () => {
  assert.deepEqual(names('ab:'), ['a', 'b', ':']);
  assert.deepEqual(names('\r\t\x7f'), ['enter', 'tab', 'backspace']);
  const ctrlC = parseKeys('\x03')[0];
  assert.equal(ctrlC.name, 'c');
  assert.equal(ctrlC.ctrl, true);
  assert.equal(parseKeys('\x15')[0].name, 'u');
});

test('cursor keys in CSI and SS3 form, with modifiers', () => {
  assert.deepEqual(names('\x1b[A\x1b[B\x1b[C\x1b[D'), ['up', 'down', 'right', 'left']);
  assert.deepEqual(names('\x1bOA'), ['up']);
  const shiftUp = parseKeys('\x1b[1;2A')[0];
  assert.equal(shiftUp.name, 'up');
  assert.equal(shiftUp.shift, true);
  assert.deepEqual(names('\x1b[5~\x1b[6~\x1b[3~\x1b[H\x1b[Z'), [
    'pageup',
    'pagedown',
    'delete',
    'home',
    'backtab',
  ]);
});

test('a lone escape is escape; ESC+key is alt', () => {
  assert.deepEqual(names('\x1b'), ['escape']);
  const alt = parseKeys('\x1bx')[0];
  assert.equal(alt.name, 'x');
  assert.equal(alt.alt, true);
});

test('SGR mouse reports: click, release, wheel, drag', () => {
  const [press] = parseKeys('\x1b[<0;10;5M');
  assert.deepEqual(
    {
      name: press.name,
      button: press.button,
      x: press.x,
      y: press.y,
      release: press.release,
    },
    { name: 'mouse', button: 0, x: 9, y: 4, release: false },
  );
  assert.equal(parseKeys('\x1b[<0;10;5m')[0].release, true);
  assert.deepEqual(names('\x1b[<64;1;1M\x1b[<65;1;1M\x1b[<32;3;3M'), [
    'wheelup',
    'wheeldown',
    'drag',
  ]);
});

test('multi-byte characters stay whole', () => {
  assert.deepEqual(names('é→'), ['é', '→']);
});
