import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectColorMode, detectUnicode, rgbTo256, createStyler, fit } from './ansi.js';

test('colour mode follows the environment', () => {
  assert.equal(detectColorMode({ COLORTERM: 'truecolor' }), 'truecolor');
  assert.equal(detectColorMode({ TERM: 'xterm-256color' }), '256');
  assert.equal(detectColorMode({ NO_COLOR: '' }), 'none');
  assert.equal(detectColorMode({ TERM: 'dumb' }), 'none');
  assert.equal(detectColorMode({ COLORTERM: 'truecolor' }, { noColor: true }), 'none');
});

test('unicode detection reads the locale', () => {
  assert.equal(detectUnicode({ LANG: 'en_US.UTF-8' }), true);
  assert.equal(detectUnicode({ LANG: 'C' }), false);
});

test('rgbTo256 maps primaries and greys sensibly', () => {
  assert.equal(rgbTo256([255, 0, 0]), 196);
  assert.equal(rgbTo256([0, 0, 0]), 16);
  assert.ok(rgbTo256([128, 128, 128]) >= 232);
});

test('styler emits SGR per mode', () => {
  assert.equal(createStyler('truecolor')('#ff0000'), '\x1b[38;2;255;0;0m');
  assert.equal(createStyler('256')('#ff0000', { bold: true }), '\x1b[1;38;5;196m');
  assert.equal(createStyler('none')('#ff0000'), '');
  assert.equal(createStyler('none')('#ff0000', { inverse: true }), '\x1b[7m');
});

test('fit pads and truncates to an exact width', () => {
  assert.equal(fit('ab', 4), 'ab  ');
  assert.equal(fit('abcdef', 4), 'abc…');
  assert.equal(fit('abcdef', 4, '~'), 'abc~');
  assert.equal(fit('x', 0), '');
});
