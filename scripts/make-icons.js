#!/usr/bin/env node
// Generate the PWA icons (public/icons/*) from code, so they are reproducible
// and need no image tooling: the ctOS mark (the favicon's design: a square
// ground tile, white corner brackets, the diamond with its filled core)
// rasterized with 4x4 supersampling and written as PNG with node:zlib.
// Run: node scripts/make-icons.js

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'icons',
);

const BG = [14, 14, 14]; // ctOS background
const INK = [255, 255, 255]; // textPrimary (brackets, core)
const GRAY = [217, 217, 217]; // ctosGray (diamond outline)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Colour of one sample point (normalized 0..1 coordinates). Square, like
 * everything in ctOS.
 * @param {boolean} maskable  artwork kept inside the maskable safe zone
 */
function shade(u, v, maskable) {
  const scale = maskable ? 0.72 : 1;
  const x = (u - 0.5) / scale;
  const y = (v - 0.5) / scale;

  // Corner brackets: L shapes 0.08 in from the edge.
  const e = 0.42;
  const arm = 0.15;
  const t = 0.022;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax <= e && ay <= e && ax >= e - arm && ay >= e - t) return INK;
  if (ax <= e && ay <= e && ay >= e - arm && ax >= e - t) return INK;

  // The diamond: an outline, a filled core, and the centre line from the top.
  const d = ax + ay;
  if (d <= 0.1) return INK;
  if (Math.abs(d - 0.28) < 0.022) return GRAY;
  if (ax < 0.011 && y < -0.1 && y > -0.28) return GRAY;
  return BG;
}

function render(size, maskable) {
  const rgba = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const c = shade(
            (px + (sx + 0.5) / ss) / size,
            (py + (sy + 0.5) / ss) / size,
            maskable,
          );
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      if (a) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return encodePng(size, rgba);
}

fs.mkdirSync(out, { recursive: true });
for (const [name, size, maskable] of [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
]) {
  fs.writeFileSync(path.join(out, name), render(size, maskable));
  console.log(`wrote public/icons/${name}`);
}
