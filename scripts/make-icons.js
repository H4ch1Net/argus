#!/usr/bin/env node
// Generate the PWA icons (public/icons/*) from code, so they are reproducible
// and need no image tooling: the Argus eye (the favicon's design) rasterized with
// 4x4 supersampling and written as PNG with node:zlib. Run: node scripts/make-icons.js

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

const BG = [5, 7, 12];
const RIM = [87, 182, 227];
const PUPIL = [87, 227, 154];

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
 * Colour of one sample point (normalized 0..1 coordinates).
 * @param {boolean} maskable  full-bleed background, artwork inside the safe zone
 */
function shade(u, v, maskable) {
  const scale = maskable ? 0.72 : 1; // keep the eye inside the maskable safe zone
  const x = (u - 0.5) / scale;
  const y = (v - 0.5) / scale;

  // Background: rounded square (or full bleed when maskable).
  if (!maskable) {
    const r = 0.22;
    const qx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
    const qy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
    if (Math.hypot(qx, qy) > r) return null; // transparent corner
  }

  // Pupil.
  if (Math.hypot(x, y) < 0.135) return PUPIL;

  // Eye outline: a lens made of two circular arcs, stroked.
  const W = 0.78;
  const H = 0.46;
  const R = ((W / 2) ** 2 + (H / 2) ** 2) / H;
  const k = R - H / 2;
  const dA = Math.hypot(x, y - k) - R; // upper arc's circle (centre below)
  const dB = Math.hypot(x, y + k) - R; // lower arc's circle (centre above)
  const lens = Math.max(dA, dB); // signed distance to the lens boundary (approx.)
  if (Math.abs(lens) < 0.032) return RIM;
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
