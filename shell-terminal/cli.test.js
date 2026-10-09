import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('military, storms and launches read the new keyless feeds', async () => {
  const calls = [];
  const soon = new Date(Date.now() + 2 * 86400_000).toISOString();
  const backend = {
    health: health(),
    client: {
      getJson: async (feed, p, opts) => {
        calls.push([feed, p, opts?.params]);
        if (feed === 'adsblol')
          return {
            ac: [
              {
                hex: 'ae0001',
                flight: 'RCH1',
                lat: 10,
                lon: 10,
                ownOp: 'USAF',
                t: 'C17',
              },
              { hex: 'ae0002', flight: 'RCH2', lat: 0.2, lon: 0.2 },
            ],
          };
        if (feed === 'nhc')
          return {
            activeStorms: [
              {
                id: 'al012026',
                name: 'Ana',
                classification: 'HU',
                intensity: '90',
                latitudeNumeric: 20,
                longitudeNumeric: -60,
              },
            ],
          };
        return {
          results: [
            {
              id: 'x',
              name: 'Rocket | Sat',
              net: soon,
              status: { abbrev: 'Go' },
              pad: { id: 1, name: 'LC-1', latitude: 1, longitude: 2 },
            },
          ],
        };
      },
    },
  };
  let c = capture();
  assert.equal(
    await runCli('military', ['--near', '0,0', '--radius', '100', '--json'], {
      ...c.io,
      backend,
    }),
    0,
  );
  assert.deepEqual(
    JSON.parse(c.out[0]).aircraft.map((a) => a.id),
    ['ae0002'],
  );
  assert.deepEqual(calls[0].slice(0, 2), ['adsblol', '/v2/mil']);

  c = capture();
  assert.equal(await runCli('storms', [], { ...c.io, backend }), 0);
  assert.match(c.out[0], /Ana\s+AL012026\s+HU cat 2\s+90 kt/);

  c = capture();
  assert.equal(await runCli('launches', ['--json'], { ...c.io, backend }), 0);
  const launches = JSON.parse(c.out[0]);
  assert.equal(launches[0].name, 'Rocket | Sat');
  assert.equal(launches[0].pad, 'LC-1');
  const llCall = calls.find(([f]) => f === 'll2');
  assert.equal(llCall[1], '/launches/');
  assert.equal(llCall[2].ordering, 'net');
});

test('upstream text cannot reach the terminal as escape sequences', async () => {
  const { escapeControls } = await import('./cli.js');
  const { createScreen } = await import('./screen.js');
  assert.equal(
    escapeControls('a\u001b]0;pwned\u0007b\u009b31m\nok\t'),
    'a\\u001b]0;pwned\\u0007b\\u009b31m\nok\t',
  );
  // Still valid JSON with the same value.
  const evil = { name: 'x\u001b[2Jy\u009b' };
  assert.deepEqual(JSON.parse(escapeControls(JSON.stringify(evil))), evil);
  const scr = createScreen(10, 1);
  scr.text(0, 0, 'A\u001b[2JB');
  assert.equal(scr.toPlain()[0], 'A?[2JB    ');
});

test('measure works offline for bundled names and coordinates', async () => {
  const { twoPlaces, resolveOffline } = await import('./cli.js');
  assert.deepEqual(twoPlaces(['New', 'York', 'to', 'Boston']), ['New York', 'Boston']);
  assert.deepEqual(twoPlaces(['London', 'Paris']), ['London', 'Paris']);
  assert.equal(twoPlaces(['New', 'York', 'Boston']), null);
  assert.equal(resolveOffline('Atlantis'), null);
  // No backend at all: neither place needs the network.
  const c = capture();
  assert.equal(
    await runCli('measure', ['London', 'Paris', '--json'], { ...c.io, backend: null }),
    0,
  );
  const m = JSON.parse(c.out[0]);
  assert.equal(m.from.name, 'London, United Kingdom');
  assert.ok(Math.abs(m.distanceKm - 343.5) < 1);
  assert.ok(Math.abs(m.bearingDeg - 148) < 1);
  const t = capture();
  assert.equal(await runCli('measure', ['0,0', '0,1'], { ...t.io, backend: null }), 0);
  assert.match(t.out[1], /111\.2 km/);
  const bad = capture();
  assert.equal(await runCli('measure', ['London'], { ...bad.io, backend: {} }), 2);
});

test('measure falls back to the geocoder for names it does not bundle', async () => {
  const backend = {
    geocode: async () => [
      { name: 'Oxford, England', latitude: 51.752, longitude: -1.2577 },
    ],
    close: async () => {},
  };
  const c = capture();
  assert.equal(
    await runCli('measure', ['London', 'Oxford', '--json'], { ...c.io, backend }),
    0,
  );
  assert.equal(JSON.parse(c.out[0]).to.name, 'Oxford, England');
});

test('route asks the osrm feed and prints turn-by-turn steps with attribution', async () => {
  const calls = [];
  const backend = {
    geocode: async () => [],
    client: {
      getJson: async (feed, p, opts) => {
        calls.push([feed, p, opts?.params]);
        return {
          code: 'Ok',
          routes: [
            {
              distance: 5200,
              duration: 3700,
              geometry: {
                coordinates: [
                  [-0.13, 51.51],
                  [-0.1, 51.52],
                ],
              },
              legs: [
                {
                  steps: [
                    {
                      maneuver: { type: 'depart', location: [-0.13, 51.51] },
                      name: 'Strand',
                      distance: 5200,
                    },
                    {
                      maneuver: { type: 'arrive', location: [-0.1, 51.52] },
                      distance: 0,
                    },
                  ],
                },
              ],
            },
          ],
        };
      },
    },
    close: async () => {},
  };
  const c = capture();
  assert.equal(
    await runCli('route', ['London', '51.52,-0.1', '--mode', 'walk'], {
      ...c.io,
      backend,
    }),
    0,
  );
  assert.equal(calls[0][0], 'osrm');
  assert.equal(calls[0][1], '/routed-foot/route/v1/foot/-0.13,51.51;-0.1,51.52');
  assert.equal(calls[0][2].geometries, 'geojson');
  assert.match(
    c.out[0],
    /^WALK London, United Kingdom -> 51\.52, -0\.1: 5\.2 km, 1 h 2 min$/,
  );
  assert.match(c.out[1], /instruction/);
  assert.match(c.out.join('\n'), /Head out on Strand/);
  assert.match(c.out.at(-1), /OpenStreetMap contributors.*fixthemap/);
  const j = capture();
  await runCli('route', ['London', 'to', '51.52,-0.1', '--json'], { ...j.io, backend });
  const r = JSON.parse(j.out[0]);
  assert.equal(r.mode, 'car');
  assert.equal(r.steps.length, 2);
  assert.equal(r.geometry.length, 2);
});

test('route --avoid-highways asks Valhalla and prints signals and alternatives', async () => {
  const fx = (n) =>
    JSON.parse(
      fs.readFileSync(new URL(`../core/nav/fixtures/${n}`, import.meta.url), 'utf8'),
    );
  const calls = [];
  const backend = {
    geocode: async () => [],
    client: {
      getJson: async (feed, p, opts) => {
        calls.push([feed, opts?.params]);
        if (feed === 'valhalla') return fx('valhalla-sf-avoid.json');
        if (feed === 'overpass') return fx('overpass-sf-signals.json');
        throw Object.assign(new Error(`no ${feed}`), { status: 502 });
      },
    },
    close: async () => {},
  };
  const c = capture();
  assert.equal(
    await runCli(
      'route',
      ['37.7749,-122.4194', '37.7599,-122.4148', '--avoid-highways'],
      {
        ...c.io,
        backend,
      },
    ),
    0,
  );
  assert.equal(calls[0][0], 'valhalla');
  assert.deepEqual(JSON.parse(calls[0][1].json).costing_options, {
    auto: { use_highways: 0 },
  });
  const text = c.out.join('\n');
  assert.match(text, /Turn left onto 16th Street/);
  assert.match(text, /via valhalla; .*\d+ traffic signals \(about \+\d/);
  assert.match(text, /alternative 2: /);
  assert.match(c.out.at(-1), /Valhalla on the FOSSGIS servers.*fixthemap/);
  const j = capture();
  await runCli(
    'route',
    ['37.7749,-122.4194', '37.7599,-122.4148', '--avoid-highways', '--json'],
    {
      ...j.io,
      backend,
    },
  );
  const r = JSON.parse(j.out[0]);
  assert.equal(r.provider, 'valhalla');
  assert.equal(r.avoidHighways, true);
  assert.ok(r.signals > 0);
  assert.equal(r.alternatives.length, 2);
  assert.equal(r.steps[0].maneuver.type, 'depart');
});

test('route refuses bad modes, long legs, no route and demo mode', async () => {
  let c = capture();
  assert.equal(
    await runCli('route', ['A', 'B', '--mode', 'boat'], { ...c.io, backend: {} }),
    2,
  );
  c = capture();
  const client = { getJson: async () => ({ code: 'NoRoute', routes: [] }) };
  assert.equal(
    await runCli('route', ['London', 'Madrid'], { ...c.io, backend: { client } }),
    1,
  );
  assert.match(c.err[0], /leg too long/);
  c = capture();
  assert.equal(
    await runCli('route', ['London', 'Paris'], { ...c.io, backend: { client } }),
    1,
  );
  assert.match(c.err[0], /no route found/);
  c = capture();
  const refused = {
    getJson: async () => {
      throw Object.assign(new Error('proxy osrm responded 400'), { status: 400 });
    },
  };
  assert.equal(
    await runCli('route', ['London', 'Paris'], { ...c.io, backend: { client: refused } }),
    1,
  );
  assert.match(c.err[0], /too far from any road/);
  c = capture();
  assert.equal(
    await runCli('route', ['London', 'Paris'], { ...c.io, backend: { client: null } }),
    1,
  );
  assert.match(c.err[0], /online only/);
});
