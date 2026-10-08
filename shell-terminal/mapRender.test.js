import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from './canvas.js';
import { makeView, metrics } from './projection.js';
import { drawPolyline, drawBasemap } from './mapRender.js';
import { builtinBasemap } from './basemap.js';

const lit = (canvas) => canvas.toCells().filter((c) => c.ch !== ' ').length;

test('a line crossing the antimeridian draws continuously on both sides', () => {
  const canvas = createCanvas(40, 10);
  const ink = canvas.ink('a', '#fff');
  const view = makeView({ lon: 180, lat: 0, degPerDot: 0.5 });
  drawPolyline(canvas, ink, view, metrics(view, 40, 10), [
    [170, 0],
    [-170, 0],
  ]);
  assert.ok(lit(canvas) >= 18, 'about 20 degrees of line across the seam');
});

test('coastlines of world-spanning rings show wherever the view is', () => {
  // Antarctica's ring spans the full 360 degrees; zoomed in on any part of it,
  // the coast must still be drawn (it used to vanish east of the start point).
  const bm = builtinBasemap();
  for (const lon of [-60, 60, 100, 140, 170]) {
    const canvas = createCanvas(60, 20);
    const ink = canvas.ink('coast', '#fff');
    const view = makeView({ lon, lat: -68, degPerDot: 0.2 });
    drawBasemap(canvas, ink, view, metrics(view, 60, 20), bm);
    assert.ok(lit(canvas) > 10, `coast drawn near ${lon}E`);
  }
});
