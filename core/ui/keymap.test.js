import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionForKey, SHORTCUTS } from './keymap.js';

const key = (k, over = {}) => ({ key: k, target: { tagName: 'BODY' }, ...over });

test('keys map to actions, presets by number', () => {
  assert.equal(actionForKey(key('h')), 'hud');
  assert.equal(actionForKey(key('H')), 'hud');
  assert.equal(actionForKey(key('o')), 'orbit');
  assert.equal(actionForKey(key('v')), 'clean');
  assert.equal(actionForKey(key('d')), 'density');
  assert.equal(actionForKey(key('n')), 'next');
  assert.equal(actionForKey(key(']')), 'next');
  assert.equal(actionForKey(key('p')), 'prev');
  assert.equal(actionForKey(key('?')), 'help');
  assert.deepEqual(actionForKey(key('1')), { preset: 0 });
  assert.deepEqual(actionForKey(key('6')), { preset: 5 });
  assert.equal(actionForKey(key('0')), null);
  assert.equal(actionForKey(key('x')), null);
});

test('typing in a field and modifier chords are left alone', () => {
  assert.equal(actionForKey(key('h', { target: { tagName: 'INPUT' } })), null);
  assert.equal(actionForKey(key('h', { target: { tagName: 'TEXTAREA' } })), null);
  assert.equal(actionForKey(key('h', { target: { isContentEditable: true } })), null);
  assert.equal(actionForKey(key('d', { ctrlKey: true })), null);
  assert.equal(actionForKey(key('1', { altKey: true })), null);
});

test('every listed shortcut has keys and a label', () => {
  for (const s of SHORTCUTS) {
    assert.ok(s.keys.length && s.label);
  }
});
