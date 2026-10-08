import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeView,
  metrics,
  project,
  unproject,
  viewBBox,
  worldDegPerDot,
  zoomView,
  panView,
  degPerDotForAltitude,
  MIN_DEG_PER_DOT,
} from './projection.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('the world view fits 360 degrees across the map', () => {
  const d = worldDegPerDot(100, 30);
  const m = metrics(makeView({ degPerDot: d }), 100, 30);
  close(m.dotsW * m.dLon, 360);
});

test('project and unproject are inverses, centre maps to the middle', () => {
  const view = makeView({ lon: 10, lat: 45, degPerDot: 0.05 });
  const m = metrics(view, 80, 24);
  const c = project(view, m, 10, 45);
  close(c.x, m.dotsW / 2);
  close(c.y, m.dotsH / 2);
  const p = project(view, m, 12.5, 44.2);
  const back = unproject(view, m, p.x, p.y);
  close(back.lon, 12.5);
  close(back.lat, 44.2);
});

test('longitude stretches by 1/cos(lat) so local shapes stay true', () => {
  const m = metrics(makeView({ lat: 60, degPerDot: 0.1 }), 80, 24);
  close(m.dLon, 0.2, 1e-9);
});

test('the view wraps across the antimeridian', () => {
  const view = makeView({ lon: 179, lat: 0, degPerDot: 0.1 });
  const m = metrics(view, 80, 24);
  const east = project(view, m, -179, 0); // 2 degrees east of centre
  close(east.x, m.dotsW / 2 + 20);
  assert.deepEqual(
    [viewBBox(view, m).lomin, viewBBox(view, m).lomax],
    [-180, 180],
    'a view straddling 180 widens to the full range like the SDK',
  );
});

test('viewBBox matches the visible region', () => {
  const view = makeView({ lon: -122, lat: 37, degPerDot: 0.01 });
  const m = metrics(view, 100, 40);
  const b = viewBBox(view, m);
  close(b.lamax - b.lamin, m.dotsH * m.dLat);
  close((b.lomin + b.lomax) / 2, -122);
});

test('zoom is clamped between street scale and the whole world', () => {
  let v = makeView({ degPerDot: 0.001 });
  v = zoomView(v, 1000, 80, 24);
  assert.equal(v.degPerDot, MIN_DEG_PER_DOT);
  v = zoomView(v, 1e-9, 80, 24);
  assert.equal(v.degPerDot, worldDegPerDot(80, 24));
});

test('pan moves by a fraction of the view and clamps latitude', () => {
  const v = makeView({ lon: 0, lat: 0, degPerDot: 1 });
  const m = metrics(v, 80, 24);
  const right = panView(v, m, 0.5, 0);
  close(right.lon, 80);
  const north = panView(v, m, 0, -10);
  assert.ok(north.lat <= 85);
});

test('altitude maps to a sensible span', () => {
  const rows = 30;
  const d = degPerDotForAltitude(1_000_000, rows);
  close(d * rows * 4, 20, 1e-9); // 1000 km altitude ~ 20 degrees of latitude
});
