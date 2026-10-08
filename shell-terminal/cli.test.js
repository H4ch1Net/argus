import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli, positionals, bboxAround, haversineKm, table } from './cli.js';
import { parseTuiArgs, parseLatLon } from './index.js';

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s) } };
}

const health = (configured = {}) => ({
  status: 'ok',
  feeds: ['opensky', 'adsblol', 'usgs-quakes', 'firms'].map((id) => ({
    id,
    configured: configured[id] ?? (id !== 'opensky' && id !== 'firms'),
  })),
});

test('helpers: positionals, bbox, distance, table', () => {
  assert.deepEqual(
    positionals(['8.8.8.8', '--json', '--proxy', 'http://x'], ['--proxy']),
    ['8.8.8.8'],
  );
  const b = bboxAround(0, 0, 111.32);
  assert.ok(Math.abs(b.lamax - 1) < 1e-9 && Math.abs(b.lomax - 1) < 1e-9);
  assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - 111.19) < 0.1);
  assert.equal(table(['a', 'bb'], [['1', '2']]).split('\n')[1], '-  --');
  assert.deepEqual(parseLatLon('33.7,-116.3'), { lat: 33.7, lon: -116.3 });
  assert.equal(parseLatLon('95,0'), null);
  assert.deepEqual(parseTuiArgs(['--demo', '--layers', 'flights,bgp'], {}).layers, [
    'flights',
    'bgp',
  ]);
  assert.deepEqual(parseTuiArgs([], { ARGUS_HOME: '51.5,-0.12' }).at, {
    lat: 51.5,
    lon: -0.12,
    span: undefined,
  });
});

test('query refuses non-assets before touching anything', async () => {
  const c = capture();
  const code = await runCli('query', ['jane', 'doe'], { ...c.io, backend: {} });
  assert.equal(code, 2);
  assert.match(c.err[0], /never people/);
});

test('query prints the passive lookup card, or JSON', async () => {
  const backend = {
    lookup: async (asset) => ({
      id: `ip:${asset.value}`,
      card: {
        title: asset.value,
        subtitle: 'IP address (passive lookup)',
        rows: [['ASN', 'AS15169']],
      },
    }),
    close: async () => {},
  };
  const c = capture();
  assert.equal(await runCli('query', ['8.8.8.8'], { ...c.io, backend }), 0);
  assert.match(c.out[0], /8\.8\.8\.8/);
  assert.match(c.out[0], /ASN\s+AS15169/);
  const j = capture();
  await runCli('query', ['8.8.8.8', '--json'], { ...j.io, backend });
  assert.equal(JSON.parse(j.out[0]).id, 'ip:8.8.8.8');
});

test('quakes filters by magnitude and sorts newest first', async () => {
  const geo = {
    features: [
      {
        id: 'a',
        properties: { mag: 2, time: 1, place: 'small' },
        geometry: { coordinates: [0, 0, 5] },
      },
      {
        id: 'b',
        properties: { mag: 5.1, time: 2, place: 'big old' },
        geometry: { coordinates: [1, 1, 10] },
      },
      {
        id: 'c',
        properties: { mag: 6, time: 3, place: 'big new' },
        geometry: { coordinates: [2, 2, 20] },
      },
    ],
  };
  const backend = {
    client: {
      getJson: async (feed, p) => (
        assert.equal(feed, 'usgs-quakes'),
        assert.equal(p, '/all_day.geojson'),
        geo
      ),
    },
  };
  const c = capture();
  assert.equal(await runCli('quakes', ['--min', '4', '--json'], { ...c.io, backend }), 0);
  assert.deepEqual(
    JSON.parse(c.out[0]).map((q) => q.id),
    ['c', 'b'],
  );
});

test('flights uses keyless adsb.lol when OpenSky has no key, nearest first', async () => {
  const calls = [];
  const backend = {
    health: health(),
    client: {
      getJson: async (feed, p) => {
        calls.push([feed, p]);
        return {
          ac: [
            { hex: 'far', lat: 1, lon: 1, flight: 'FAR1' },
            { hex: 'near', lat: 0.1, lon: 0.1, flight: 'NEAR1' },
          ],
        };
      },
    },
  };
  const c = capture();
  assert.equal(
    await runCli('flights', ['--near', '0,0', '--radius', '100', '--json'], {
      ...c.io,
      backend,
    }),
    0,
  );
  const res = JSON.parse(c.out[0]);
  assert.equal(res.source, 'adsb.lol');
  assert.deepEqual(
    res.aircraft.map((a) => a.id),
    ['near', 'far'],
  );
  assert.equal(calls[0][0], 'adsblol');
  assert.match(calls[0][1], /^\/v2\/lat\/0\/lon\/0\/dist\/\d+$/);
});

test('flights and fires require --near; fires explains a missing key', async () => {
  const c = capture();
  assert.equal(await runCli('flights', [], { ...c.io, backend: {} }), 2);
  const f = capture();
  assert.equal(
    await runCli('fires', ['--near', '0,0'], { ...f.io, backend: { health: health() } }),
    1,
  );
  assert.match(f.err[0], /FIRMS_MAP_KEY/);
});
