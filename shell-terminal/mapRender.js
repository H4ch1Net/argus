// Draw geography onto the braille canvas: coastlines, graticule, tracks. Pure.

import { project } from './projection.js';
import { graticuleStep } from './basemap.js';
import { shortestLonDelta } from '../core/layers/sdk/interpolate.js';

/**
 * Draw a [lon, lat] polyline. Longitudes are unwrapped point to point, so a line
 * that crosses the antimeridian stays continuous, and it is drawn again shifted a
 * full turn either way so whatever part falls on screen after wrapping shows up.
 */
export function drawPolyline(canvas, ink, view, m, points, { close = false } = {}) {
  if (points.length < 2) return;
  const turn = 360 / m.dLon; // dots per full turn of longitude
  const first = project(view, m, points[0][0], points[0][1]);
  const xs = [first.x];
  const ys = [first.y];
  for (let i = 1; i < points.length; i += 1) {
    const dl = shortestLonDelta(points[i - 1][0], points[i][0]);
    xs.push(xs[i - 1] + dl / m.dLon);
    ys.push(project(view, m, points[i][0], points[i][1]).y);
  }
  if (close) {
    const dl = shortestLonDelta(points[points.length - 1][0], points[0][0]);
    xs.push(xs[xs.length - 1] + dl / m.dLon);
    ys.push(ys[0]);
  }
  // Always draw the copies a full turn either side: a line spanning more than
  // half the world (Eurasia, Antarctica) can sit a turn away from the view once
  // unwrapped. Off-screen copies are clipped away cheaply.
  for (const s of [0, -turn, turn]) {
    for (let i = 1; i < xs.length; i += 1) {
      canvas.line(ink, xs[i - 1] + s, ys[i - 1], xs[i] + s, ys[i]);
    }
  }
}

/** Coastlines. Lines entirely outside the visible latitude band are skipped. */
export function drawBasemap(canvas, ink, view, m, basemap) {
  const halfLat = (m.dotsH / 2) * m.dLat;
  const south = view.lat - halfLat;
  const north = view.lat + halfLat;
  for (const line of basemap.lines) {
    if (line.maxLat < south || line.minLat > north) continue;
    drawPolyline(canvas, ink, view, m, line.points);
  }
}

/** Sparse dotted graticule with a spacing that suits the zoom level. */
export function drawGraticule(canvas, ink, view, m) {
  const spanLat = m.dotsH * m.dLat;
  const step = graticuleStep(spanLat);
  const latAt = (y) => view.lat - (y - m.dotsH / 2) * m.dLat;
  // Parallels: a dot every fourth column keeps them faint next to the coastline.
  for (let y = 0; y < m.dotsH; y += 1) {
    const lat = latAt(y);
    if (Math.abs(lat) > 90) continue;
    if (Math.floor((lat - m.dLat) / step) !== Math.floor(lat / step)) {
      for (let x = 0; x < m.dotsW; x += 4) canvas.dot(ink, x, y);
    }
  }
  // Meridians, only between the poles.
  for (let x = 0; x < m.dotsW; x += 1) {
    const lon = view.lon + (x - m.dotsW / 2) * m.dLon;
    if (Math.floor((lon + m.dLon) / step) === Math.floor(lon / step)) continue;
    for (let y = 0; y < m.dotsH; y += 3) {
      if (Math.abs(latAt(y)) <= 90) canvas.dot(ink, x, y);
    }
  }
  return step;
}
