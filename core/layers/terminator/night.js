// Day/night terminator and night-side shade, computed (no feed), pure: no
// Cesium, no DOM. The subsolar point comes from core/geo/sun.js; the sun's
// elevation anywhere is then sin(el) = sin(lat) sin(dec) + cos(lat) cos(dec)
// cos(lon - lon0), worked out per pixel row and column (no trig per pixel).
//
// The overlay is one equirectangular RGBA image of the globe: transparent by
// day, deepening through twilight to a translucent ctOS-ground shade by full
// night (sun 12 degrees down), the terminator itself as a slate hairline, and
// optionally city lights (NASA Black Marble intensities) on the night side
// only, fading in after sunset.

import { subsolarPoint } from '../../geo/sun.js';
import { INK } from '../../ui/palette.js';

const D2R = Math.PI / 180;
const SIN12 = Math.sin(12 * D2R);
const SIN2 = Math.sin(2 * D2R);
const SIN8 = Math.sin(8 * D2R);

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const GROUND = rgb(INK.ground);
const LINE = rgb(INK.slate);
const LIGHT = rgb(INK.pale);

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Sine of the sun's elevation at a point, for a subsolar point. */
export function sinElevation(lat, lon, sub) {
  return (
    Math.sin(lat * D2R) * Math.sin(sub.lat * D2R) +
    Math.cos(lat * D2R) * Math.cos(sub.lat * D2R) * Math.cos((lon - sub.lon) * D2R)
  );
}

/** How dark (0 day .. 1 full night) for a sine of the elevation. */
export const nightness = (s) => smooth(-s / SIN12);

/**
 * The terminator (sun on the horizon) as [[lon, lat], ...] around the globe:
 * the great circle 90 degrees from the subsolar point.
 */
export function terminatorLine(date = new Date(), steps = 180) {
  const sub = subsolarPoint(date);
  const lat0 = sub.lat * D2R;
  const out = [];
  for (let i = 0; i <= steps; i += 1) {
    const b = (i / steps) * 2 * Math.PI; // bearing from the subsolar point
    // Destination 90 degrees away along bearing b.
    const lat = Math.asin(Math.cos(lat0) * Math.cos(b));
    const lon =
      sub.lon * D2R +
      Math.atan2(Math.sin(b) * Math.cos(lat0), -Math.sin(lat0) * Math.sin(lat));
    out.push([((((lon / D2R + 180) % 360) + 360) % 360) - 180, lat / D2R]);
  }
  return out;
}

/**
 * City-light intensities (0..255 per pixel) from an RGBA image of the night
 * lights: the brightest channel above a floor (the image's near-black
 * background), stretched.
 */
export function lightsIntensity(rgba, width, height, floor = 24) {
  const out = new Uint8Array(width * height);
  for (let i = 0, k = 0; i < out.length; i += 1, k += 4) {
    const m = Math.max(rgba[k], rgba[k + 1], rgba[k + 2]);
    out[i] = m <= floor ? 0 : Math.min(255, (m - floor) * 1.4);
  }
  return out;
}

/**
 * RGBA pixels (row 0 = north, column 0 = -180) of the night overlay at an
 * instant. `lights` (from lightsIntensity, same size) adds city lights on
 * the night side. `out` may be reused between calls.
 */
export function nightPixels(
  date,
  width,
  height,
  { lights = null, shade = 0.55, out = null } = {},
) {
  const px = out ?? new Uint8ClampedArray(width * height * 4);
  const sub = subsolarPoint(date);
  const sd = Math.sin(sub.lat * D2R);
  const cd = Math.cos(sub.lat * D2R);
  const cosDl = new Float64Array(width);
  for (let i = 0; i < width; i += 1) {
    const lon = -180 + ((i + 0.5) * 360) / width;
    cosDl[i] = Math.cos((lon - sub.lon) * D2R);
  }
  // The hairline: about one and a half pixels wide at this resolution.
  const lineS = Math.sin(((0.75 * 180) / height) * D2R);
  for (let j = 0; j < height; j += 1) {
    const lat = (90 - ((j + 0.5) * 180) / height) * D2R;
    const a = Math.sin(lat) * sd;
    const b = Math.cos(lat) * cd;
    for (let i = 0; i < width; i += 1) {
      const s = a + b * cosDl[i];
      const k = (j * width + i) * 4;
      if (Math.abs(s) < lineS) {
        px[k] = LINE[0];
        px[k + 1] = LINE[1];
        px[k + 2] = LINE[2];
        px[k + 3] = 190;
        continue;
      }
      const n = nightness(s);
      const sa = n * shade;
      const la = lights
        ? (lights[j * width + i] / 255) * smooth((-s - SIN2) / (SIN8 - SIN2))
        : 0;
      const A = la + sa * (1 - la);
      if (A <= 0.004) {
        px[k + 3] = 0;
        continue;
      }
      const w = la / A;
      px[k] = LIGHT[0] * w + GROUND[0] * (1 - w);
      px[k + 1] = LIGHT[1] * w + GROUND[1] * (1 - w);
      px[k + 2] = LIGHT[2] * w + GROUND[2] * (1 - w);
      px[k + 3] = A * 255;
    }
  }
  return px;
}

/**
 * Overlay width for the frame rate the tier animates at (the wind layer uses
 * the same cue): 2048 on the full tier, 1024 otherwise.
 */
export const terminatorWidth = (fps) => (fps >= 30 ? 2048 : 1024);

/** Query params for the proxy's 'gibs-night' feed: one global Black Marble image. */
export function blackMarbleQuery(width = 1024) {
  const w = width >= 2048 ? 2048 : 1024;
  return {
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: '1.3.0',
    LAYERS: 'VIIRS_Black_Marble',
    STYLES: '',
    CRS: 'EPSG:4326',
    // WMS 1.3.0 with EPSG:4326 orders the box latitude first.
    BBOX: '-90,-180,90,180',
    WIDTH: String(w),
    HEIGHT: String(w / 2),
    FORMAT: 'image/png',
  };
}
export const BLACK_MARBLE_PATH = '/wms.cgi';
