import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runCli } from './cli.js';
import { createLookup } from '../core/osint/lookup.js';
import {
  createSimDriver,
  viewOfBbox,
  describeSimVehicle,
} from '../core/layers/simtraffic/driver.js';
import { createTrafficModel } from '../core/layers/simtraffic/source.js';
import { demoFlowSegment, demoGridWays } from '../core/layers/simtraffic/mockSource.js';

// The terminal's commands for the round-6 intel: flow, shodan, photo, and the
// InternetDB section `argus query` now prints. Fake backends only.

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}
const health = (ids) => ({
  status: 'ok',
  feeds: ['tomtom-flowseg', 'shodan', 'mapillary'].map((id) => ({
    id,
    configured: ids.includes(id),
  })),
});
const INTERNETDB = JSON.parse(
  fs.readFileSync(
    new URL('../core/osint/fixtures/internetdb.json', import.meta.url),
    'utf8',
  ),
);

test('flow: the TomTom speed on the nearest road, or which key is missing', async () => {
  const asked = [];
  const backend = {
    health: health(['tomtom-flowseg']),
    client: {
      async getJson(feed, path, { params }) {
        asked.push([feed, path, params.point]);
        return {
          flowSegmentData: {
            frc: 'FRC1',
            currentSpeed: 38,
            freeFlowSpeed: 76,
            currentTravelTime: 90,
            freeFlowTravelTime: 45,
            confidence: 1,
            roadClosure: false,
            coordinates: {
              coordinate: [
                { latitude: 51.5, longitude: -0.12 },
                { latitude: 51.501, longitude: -0.121 },
              ],
            },
          },
        };
      },
    },
    close: async () => {},
  };
  const c = capture();
  assert.equal(await runCli('flow', ['51.5,-0.12'], { ...c.io, backend }), 0);
  assert.deepEqual(asked, [
    ['tomtom-flowseg', '/flowSegmentData/absolute/14/json', '51.50000,-0.12000'],
  ]);
  assert.match(c.out[0], /38 \/ 76 KM\/H \(50%\)/);
  assert.match(c.out.at(-1), /© TomTom/);
  const none = capture();
  const code = await runCli('flow', ['51.5,-0.12'], {
    ...none.io,
    backend: { ...backend, health: health([]) },
  });
  assert.equal(code, 1);
  assert.match(none.err[0], /needs TOMTOM_API_KEY/);
  const usage = capture();
  assert.equal(await runCli('flow', [], { ...usage.io, backend }), 2);
});

test('shodan: snapshots listed offline, counts by country, no free text', async () => {
  const list = capture();
  assert.equal(
    await runCli('shodan', ['--snapshot', 'list'], { ...list.io, backend: {} }),
    0,
  );
  assert.match(list.out.join('\n'), /modbus\s+Industrial control \(Modbus\)\s+port:502/);
  const bad = capture();
  assert.equal(
    await runCli('shodan', ['--snapshot', 'apache'], { ...bad.io, backend: {} }),
    2,
  );
  const asked = [];
  const backend = {
    health: health(['shodan']),
    client: {
      async getJson(feed, path, { params }) {
        asked.push(params);
        return params.query.includes('country:')
          ? {
              total: 5,
              facets: { port: [{ value: 502, count: 5 }], org: [], product: [] },
            }
          : {
              total: 30,
              facets: {
                country: [
                  { value: 'US', count: 20 },
                  { value: 'DE', count: 10 },
                ],
              },
            };
      },
    },
    close: async () => {},
  };
  const c = capture();
  assert.equal(await runCli('shodan', ['--snapshot', 'modbus'], { ...c.io, backend }), 0);
  assert.deepEqual(asked[0], { query: 'port:502', facets: 'country:200' });
  assert.match(c.out.join('\n'), /US\s+20/);
  const d = capture();
  assert.equal(
    await runCli('shodan', ['--snapshot', 'modbus', '--country', 'de'], {
      ...d.io,
      backend,
    }),
    0,
  );
  assert.equal(asked[1].query, 'port:502 country:DE');
  assert.match(d.out.join('\n'), /Top ports\s+502 \(5\)/);
});

test('photo: the nearest street photo card with its Mapillary link', async () => {
  const backend = {
    health: health(['mapillary']),
    client: {
      buildUrl: (f, p) => `https://proxy.test/feed/${f}${p}`,
      async getJson() {
        return {
          data: [
            {
              id: '987654321',
              captured_at: 1717250700000,
              compass_angle: 90,
              geometry: { type: 'Point', coordinates: [-0.1201, 51.5001] },
            },
          ],
        };
      },
    },
    close: async () => {},
  };
  const c = capture();
  assert.equal(await runCli('photo', ['51.5,-0.12'], { ...c.io, backend }), 0);
  const text = c.out.join('\n');
  assert.match(text, /PHOTO 090° E/);
  assert.match(text, /Facing\s+090° E/);
  assert.match(text, /mapillary\.com\/app\/\?pKey=987654321/);
});

test('query prints the InternetDB exposure of an IP', async () => {
  const client = {
    async getJson(feed, path) {
      if (feed === 'internetdb') return INTERNETDB[path.slice(1)];
      return null;
    },
  };
  const c = capture();
  const backend = { lookup: createLookup(client), close: async () => {} };
  assert.equal(await runCli('query', ['45.33.32.156'], { ...c.io, backend }), 0);
  const text = c.out.join('\n');
  assert.match(text, /Exposure \(InternetDB\)/);
  assert.match(text, /Open ports\s+22, 80, 123, 31337/);
  assert.match(text, /Known CVEs\s+\d+ \(CVE-2026-/);
});

test('the terminal sim driver follows the model and moves vehicles', async () => {
  const model = createTrafficModel({
    tier: 'minimal',
    demo: true,
    fetchWays: async (band, tile) => demoGridWays(band, tile),
    fetchFlow: async (s) => demoFlowSegment(s),
  });
  const bbox = { lamin: 51.49, lomin: -0.13, lamax: 51.51, lomax: -0.11 };
  const view = viewOfBbox(bbox);
  assert.ok(view.heightM > 1000 && view.heightM < 8000);
  await model.update(view);
  await new Promise((r) => setTimeout(r, 30));
  const d = createSimDriver({ cap: 150 });
  d.sync(model);
  const t0 = 1_000_000;
  const list = d.vehicles(t0);
  assert.equal(list.length, 150);
  const a = d.positionAt(0, t0);
  const b = d.positionAt(0, t0 + 5000);
  assert.ok(a.longitude !== b.longitude || a.latitude !== b.latitude, 'moves with time');
  const card = describeSimVehicle(list[0], d.speedKmh(0));
  assert.equal(card.title, 'SIMULATED VEHICLE');
  assert.match(card.subtitle, /not a real vehicle/);
  // Zoomed out past 8 km: nothing.
  await model.update(viewOfBbox({ lamin: 50, lomin: -1, lamax: 52, lomax: 1 }));
  d.sync(model);
  assert.deepEqual(d.vehicles(t0 + 6000), []);
});
