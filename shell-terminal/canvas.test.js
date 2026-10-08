import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from './canvas.js';

test('dots pack into braille cells', () => {
  const c = createCanvas(2, 1);
  const k = c.ink('a', '#fff');
  c.dot(k, 0, 0); // top-left of cell 0
  c.dot(k, 3, 3); // bottom-right of cell 1
  const cells = c.toCells();
  assert.equal(cells[0].ch, '⠁');
  assert.equal(cells[1].ch, '⢀');
  assert.equal(cells[0].fg, '#fff');
});

test('out-of-range dots and lines are ignored safely', () => {
  const c = createCanvas(4, 2);
  const k = c.ink('a', '#fff');
  c.dot(k, -1, 0);
  c.dot(k, 100, 100);
  c.line(k, -1000, -1000, -500, -500); // fully outside: clipped away
  assert.ok(c.toCells().every((x) => x.ch === ' '));
});

test('lines are clipped to the canvas and drawn continuously', () => {
  const c = createCanvas(10, 1);
  const k = c.ink('a', '#fff');
  c.line(k, -50, 1, 500, 1);
  const lit = c.toCells().filter((x) => x.ch !== ' ').length;
  assert.equal(lit, 10);
});

test('higher-priority ink colours a shared cell; glyphs beat inks', () => {
  const c = createCanvas(2, 1);
  const lo = c.ink('grid', '#111', 0);
  const hi = c.ink('coast', '#999', 1);
  c.dot(lo, 0, 0);
  c.dot(hi, 0, 1);
  assert.equal(c.toCells()[0].fg, '#999');
  c.glyph(1, 0, 'X', '#f00');
  c.dot(hi, 2, 0);
  assert.equal(c.toCells()[1].ch, 'X');
});

test('glyph priority decides contested cells; text never covers entities', () => {
  const c = createCanvas(4, 1);
  c.glyph(0, 0, 'a', null, { priority: 1 });
  assert.equal(c.glyph(0, 0, 'b', null, { priority: 0 }), false);
  assert.equal(c.glyph(0, 0, 'c', null, { priority: 5 }), true);
  c.text(0, 0, 'xyz', null, { priority: -1 });
  assert.deepEqual(
    c
      .toCells()
      .map((x) => x.ch)
      .join(''),
    'cyz ',
  );
});

test('ascii mode replaces braille with density characters', () => {
  const c = createCanvas(1, 1);
  const k = c.ink('a', '#fff');
  c.dot(k, 0, 0);
  assert.equal(c.toCells({ ascii: true })[0].ch, '.');
  for (let y = 0; y < 4; y += 1) for (let x = 0; x < 2; x += 1) c.dot(k, x, y);
  assert.equal(c.toCells({ ascii: true })[0].ch, '#');
});
