import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sinElevation,
  nightness,
  terminatorLine,
  lightsIntensity,
  nightPixels,
  blackMarbleQuery,
  BLACK_MARBLE_PATH,
  terminatorWidth,
} from './night.js';
import { createTerminatorSource } from './source.js';
import { subsolarPoint, sunElevationDeg } from '../../geo/sun.js';
import { INK } from '../../ui/palette.js';

const T = new Date('2026-10-08T15:00:00Z');

test('the terminator line is where the sun sits on the horizon', () => {
  const line = terminatorLine(T, 72);
  assert.equal(line.length, 73);
  const sub = subsolarPoint(T);
  for (const [lon, lat] of line) {
    assert.ok(lon >= -180 && lon <= 180 && Math.abs(lat) <= 90);
    assert.ok(Math.abs(sinElevation(lat, lon, sub)) < 1e-9);
    // The solar-calculator elevation agrees (it adds refraction, under a degree).
    assert.ok(Math.abs(sunElevationDeg(lat, lon, T)) < 1.2);
  }
});

test('nightness: zero by day, rising through twilight, one past 12 degrees down', () => {
  const s = (deg) => Math.sin((deg * Math.PI) / 180);
  assert.equal(nightness(s(10)), 0);
  assert.equal(nightness(s(0)), 0);
  assert.ok(nightness(s(-6)) > 0.3 && nightness(s(-6)) < 0.7);
  assert.equal(nightness(s(-12)), 1);
  assert.equal(nightness(s(-40)), 1);
});

test('night pixels: clear under the sun, shaded opposite, a hairline between', () => {
  const w = 360;
  const h = 180;
  const sub = subsolarPoint(T);
  const px = nightPixels(T, w, h, { shade: 0.5 });
  const at = (lon, lat) => {
    const i = Math.min(w - 1, Math.floor(((lon + 180) / 360) * w));
    const j = Math.min(h - 1, Math.floor(((90 - lat) / 180) * h));
    return px.subarray((j * w + i) * 4, (j * w + i) * 4 + 4);
  };
  assert.equal(at(sub.lon, sub.lat)[3], 0, 'day side is transparent');
  const anti = ((sub.lon + 360) % 360) - 180;
  const night = at(anti, -sub.lat);
  assert.ok(Math.abs(night[3] - 127) <= 1, `night alpha ${night[3]}`);
  const ground = [1, 3, 5].map((i) => parseInt(INK.ground.slice(i, i + 2), 16));
  assert.deepEqual([...night.subarray(0, 3)], ground);
  // Some pixel on the terminator is the slate hairline.
  const slate = [1, 3, 5].map((i) => parseInt(INK.slate.slice(i, i + 2), 16));
  let lines = 0;
  for (let k = 0; k < px.length; k += 4)
    if (px[k] === slate[0] && px[k + 1] === slate[1] && px[k + 3] === 190) lines += 1;
  assert.ok(lines > w, `hairline pixels ${lines}`);
});

test('city lights show on the night side only', () => {
  const w = 72;
  const h = 36;
  const lights = new Uint8Array(w * h).fill(255);
  const px = nightPixels(T, w, h, { lights });
  const sub = subsolarPoint(T);
  const idx = (lon, lat) =>
    (Math.floor(((90 - lat) / 180) * h) * w + Math.floor(((lon + 180) / 360) * w)) * 4;
  assert.equal(px[idx(sub.lon, sub.lat) + 3], 0, 'no lights by day');
  const anti = ((sub.lon + 360) % 360) - 180;
  const k = idx(anti, -sub.lat);
  assert.equal(px[k + 3], 255, 'full lights at night');
  const pale = [1, 3, 5].map((i) => parseInt(INK.pale.slice(i, i + 2), 16));
  assert.deepEqual([...px.subarray(k, k + 3)], pale);
  // Reusing an output buffer gives the same picture.
  const out = new Uint8ClampedArray(w * h * 4);
  assert.deepEqual(nightPixels(T, w, h, { lights, out }), px);
});

test('light intensities drop the dark background', () => {
  const rgba = new Uint8ClampedArray([10, 10, 20, 255, 200, 180, 90, 255, 30, 30, 30, 255]);
  const L = lightsIntensity(rgba, 3, 1);
  assert.equal(L[0], 0);
  assert.equal(L[1], Math.floor((200 - 24) * 1.4));
  assert.ok(L[2] > 0 && L[2] < 20);
});

test('the Black Marble request is one pinned global image; the source fetches it once', async () => {
  const q = blackMarbleQuery(1024);
  assert.equal(q.LAYERS, 'VIIRS_Black_Marble');
  assert.equal(q.BBOX, '-90,-180,90,180');
  assert.equal(q.WIDTH, '1024');
  assert.equal(q.HEIGHT, '512');
  assert.equal(blackMarbleQuery(4096).WIDTH, '2048');
  assert.equal(terminatorWidth(30), 2048);
  assert.equal(terminatorWidth(15), 1024);
  const calls = [];
  const proxyClient = {
    getBytes: async (id, path, opts) => {
      calls.push({ id, path, params: opts.params });
      return new Uint8Array([1, 2, 3]);
    },
  };
  const src = createTerminatorSource({ proxyClient, width: 2048 });
  const a = await src();
  const b = await src();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'gibs-night');
  assert.equal(calls[0].path, BLACK_MARBLE_PATH);
  assert.equal(calls[0].params.WIDTH, '2048');
  assert.equal(a.lights, b.lights);
  assert.deepEqual([...(await a.lights)], [1, 2, 3]);
  assert.ok(Number.isFinite(a.at));
  // Offline (no proxy): shade only.
  assert.equal((await createTerminatorSource()()).lights, null);
});
