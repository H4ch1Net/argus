import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOvation,
  parseKp,
  sampleOvation,
  auroraPixels,
  auroraNote,
  formatAurora,
  hhmmZ,
  AURORA_PATH,
  KP_PATH,
} from './parse.js';
import { createAuroraSource, demoOvation, createAuroraMockSource } from './source.js';

test('the OVATION grid parses into a 1 degree global grid', () => {
  const g = parseOvation(demoOvation(5));
  assert.equal(g.nx, 360);
  assert.equal(g.ny, 181);
  assert.equal(g.count, 360 * 181);
  assert.ok(g.max > 30, 'an oval is present');
  assert.match(g.forecast, /Z$/);
  // The oval: likely near 60 degrees, nothing at the equator.
  assert.ok(sampleOvation(g, 290, 60) > 20);
  assert.equal(sampleOvation(g, 0, 0), 0);
  // Longitudes may come as -180..180 too: same answer.
  assert.equal(sampleOvation(g, -70, 60), sampleOvation(g, 290, 60));
  assert.equal(parseOvation({ coordinates: [[0, 0, 1]] }), null, 'too small');
  assert.equal(parseOvation(null), null);
});

test('values are clamped and junk rows skipped', () => {
  const coordinates = [];
  for (let lon = 0; lon < 360; lon += 1) coordinates.push([lon, 70, 250], [lon, 71, 'x']);
  for (let i = 0; i < 720; i += 1) coordinates.push([i % 360, -70 - (i >= 360), 5]);
  const g = parseOvation({ coordinates });
  assert.equal(g.max, 100);
  assert.equal(sampleOvation(g, 10, 70), 100);
});

test('the K index: current object rows and the older table shape', () => {
  assert.deepEqual(
    parseKp([
      { time_tag: '2026-10-08T12:00:00', kp_index: 2, estimated_kp: 2.33 },
      { time_tag: '2026-10-08T12:01:00', kp_index: 3, estimated_kp: 3.67 },
      { time_tag: 'bad', kp_index: 'x' },
    ]),
    { kp: 3.67, time: '2026-10-08T12:01:00' },
  );
  assert.deepEqual(
    parseKp([
      ['time_tag', 'Kp', 'a_running', 'station_count'],
      ['2026-10-08 06:00:00.000', '2.00', '7', '8'],
      ['2026-10-08 09:00:00.000', '4.33', '32', '8'],
    ]),
    { kp: 4.33, time: '2026-10-08 09:00:00.000' },
  );
  assert.equal(parseKp([['time_tag', 'other']]), null);
  assert.equal(parseKp('nope'), null);
});

test('overlay pixels: transparent at low latitudes, mint over the oval', () => {
  const g = parseOvation(demoOvation(5));
  const w = 360;
  const h = 180;
  const px = auroraPixels(g, w, h);
  assert.equal(px.length, w * h * 4);
  const at = (lon, lat) => {
    const i = Math.floor(((lon + 180) / 360) * w);
    const j = Math.floor(((90 - lat) / 180) * h);
    return px.subarray((j * w + i) * 4, (j * w + i) * 4 + 4);
  };
  assert.equal(at(0, 0)[3], 0);
  const oval = at(-70, 60);
  assert.ok(oval[3] > 60, `alpha ${oval[3]}`);
  assert.ok(oval[1] >= oval[0], 'mint: green-leaning');
  assert.equal(auroraPixels(null, 4, 2).every((v) => v === 0), true);
});

test('notes and readouts', () => {
  assert.equal(hhmmZ('2026-10-08T12:50:00Z'), '12:50Z');
  assert.equal(hhmmZ(null), '');
  assert.equal(
    auroraNote({ kp: { kp: 3.33 }, forecast: '2026-10-08T12:50:00Z' }),
    'Kp 3.3, forecast 12:50Z',
  );
  assert.equal(auroraNote(null), '');
  assert.equal(formatAurora({ probability: 12.4, kp: 3.33 }), '12% Kp 3.3');
  assert.equal(formatAurora(null), '--');
});

test('the source reads both SWPC files and tolerates a missing K index', async () => {
  const asked = [];
  const proxyClient = {
    getJson: async (id, path) => {
      asked.push(`${id}${path}`);
      if (path === KP_PATH) throw new Error('502');
      return demoOvation(3);
    },
  };
  const out = await createAuroraSource({ proxyClient })({}, undefined);
  assert.deepEqual(asked.sort(), [`swpc${AURORA_PATH}`, `swpc${KP_PATH}`].sort());
  assert.ok(out.grid);
  assert.equal(out.kp, null);
  const bad = createAuroraSource({ proxyClient: { getJson: async () => ({}) } });
  await assert.rejects(bad({}), /no aurora grid/);
  const mock = await createAuroraMockSource()();
  assert.equal(mock.kp.kp, 4);
});
