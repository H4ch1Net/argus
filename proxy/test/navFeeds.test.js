import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { feeds } from '../feeds.js';
import { osrmStopsAllowed, valhallaQueryOk } from '../feeds/nav.js';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import { createGovernor } from '../lib/governor.js';
import * as nav from '../../core/nav/providers.js';
import { tomtomSearchRequest } from '../../core/nav/search.js';
import { censusParams } from '../../core/search/census.js';
import { regionParams } from '../../core/search/region.js';
import { nominatimAddressParams } from '../../core/search/address.js';
import { reverseQuery } from '../../core/cockpit/briefing.js';

const feed = (id) => feeds.find((f) => f.id === id);
const pathOk = (id, p) => feed(id).allowPaths.some((re) => re.test(p));
const queryOk = (id, s) => feed(id).allowQuery(new URLSearchParams(s));

test('osrm: each service with its own profile, 2 to 12 stops, nothing else', () => {
  const ab = '-0.1278,51.5074;-1.2577,51.752';
  assert.equal(pathOk('osrm', `/routed-car/route/v1/driving/${ab}`), true);
  assert.equal(pathOk('osrm', `/routed-foot/route/v1/foot/${ab}`), true);
  assert.equal(pathOk('osrm', `/routed-bike/route/v1/bike/${ab}`), true);
  // Mismatched service/profile, other OSRM services, one stop, 13 stops.
  assert.equal(pathOk('osrm', `/routed-car/route/v1/foot/${ab}`), false);
  assert.equal(pathOk('osrm', `/routed-car/table/v1/driving/${ab}`), false);
  assert.equal(pathOk('osrm', `/routed-car/trip/v1/driving/${ab}`), false);
  assert.equal(pathOk('osrm', '/routed-car/route/v1/driving/-0.1278,51.5074'), false);
  const near = Array.from({ length: 12 }, (_, i) => `0.${i},51.5`).join(';');
  assert.equal(pathOk('osrm', `/routed-car/route/v1/driving/${near}`), true);
  assert.equal(pathOk('osrm', `/routed-car/route/v1/driving/${near};0.9,51.5`), false);
  assert.equal(pathOk('osrm', `/routed-car/route/v1/driving/${ab}.json`), false);
  assert.equal(pathOk('osrm', `/routed-car/route/v1/driving/${ab}/../../x`), false);
  // Distances a regex cannot see: London to Madrid in one leg, a 2,780 km chain, off-globe.
  assert.equal(
    pathOk('osrm', '/routed-car/route/v1/driving/-0.13,51.5;-3.7,40.4'),
    false,
  );
  const chain = [0, 5, 10, 15, 20, 25].map((lon) => `${lon},0`).join(';');
  assert.equal(osrmStopsAllowed(chain), false);
  assert.equal(osrmStopsAllowed('0,0;0,1'), true);
  assert.equal(pathOk('osrm', '/routed-car/route/v1/driving/0,95;0,1'), false);
  assert.equal(pathOk('osrm', '/routed-car/route/v1/driving/181,0;180,0'), false);
});

test('osrm: query pinned to one GeoJSON route; UA, governor and cache set', () => {
  const ok = 'overview=full&geometries=geojson&alternatives=false&steps=true';
  assert.equal(queryOk('osrm', ok), true);
  assert.equal(queryOk('osrm', 'geometries=geojson'), true);
  assert.equal(queryOk('osrm', 'overview=full&steps=true'), false); // polyline geometry
  assert.equal(
    queryOk('osrm', ok.replace('alternatives=false', 'alternatives=3')),
    false,
  );
  assert.equal(queryOk('osrm', `${ok}&annotations=true`), false);
  assert.equal(queryOk('osrm', `${ok}&steps=false`), false); // repeated key
  assert.equal(queryOk('osrm', `${ok}&constructor=x`), false);
  const f = feed('osrm');
  assert.match(f.headers['user-agent'], /^Argus\/.+github\.com/);
  assert.equal(f.governor.ratePerMinute, 30);
  assert.equal(f.cache.ttlMs, 10 * 60_000);
  assert.equal(f.inject, undefined);
});

test('photon: /api with q, limit and a lat/lon bias only', () => {
  assert.equal(pathOk('photon', '/api/'), true);
  assert.equal(pathOk('photon', '/api'), true);
  assert.equal(pathOk('photon', '/reverse'), false);
  assert.equal(pathOk('photon', '/api/x'), false);
  assert.equal(queryOk('photon', 'q=hoan+kiem&limit=5&lat=30.3&lon=-97.7'), true);
  assert.equal(queryOk('photon', 'q=paris'), true);
  assert.equal(queryOk('photon', ''), false);
  assert.equal(queryOk('photon', 'q=%20'), false);
  assert.equal(queryOk('photon', `q=${'a'.repeat(201)}`), false);
  assert.equal(queryOk('photon', 'q=a&limit=50'), false);
  assert.equal(queryOk('photon', 'q=a&limit=0'), false);
  assert.equal(queryOk('photon', 'q=a&lat=10'), false); // half a bias
  assert.equal(queryOk('photon', 'q=a&lat=91&lon=0'), false);
  assert.equal(queryOk('photon', 'q=a&lat=1e1&lon=0'), false);
  assert.equal(queryOk('photon', 'q=a&bbox=0,0,1,1'), false); // a hard filter, never sent
  assert.equal(queryOk('photon', 'q=a&osm_tag=place'), false);
  assert.equal(queryOk('photon', 'q=a&q=b'), false);
  const f = feed('photon');
  assert.match(f.headers['user-agent'], /^Argus\//);
  assert.ok(f.governor.ratePerMinute <= 30);
  assert.ok(f.cache.ttlMs >= 60 * 60_000);
});

const qs = (params) => new URLSearchParams(params).toString();

test('census-geocoder: one address line, the current benchmark, JSON; nothing else', () => {
  assert.equal(pathOk('census-geocoder', '/geocoder/locations/onelineaddress'), true);
  assert.equal(pathOk('census-geocoder', '/geocoder/locations/address'), false);
  assert.equal(pathOk('census-geocoder', '/geocoder/geographies/onelineaddress'), false);
  assert.equal(pathOk('census-geocoder', '/geocoder/locations/addressbatch'), false);
  // What core sends passes.
  assert.equal(
    queryOk('census-geocoder', qs(censusParams('46211 Jackson street, CA'))),
    true,
  );
  const ok = 'address=46211+Jackson+st%2C+CA&benchmark=Public_AR_Current&format=json';
  assert.equal(queryOk('census-geocoder', ok), true);
  assert.equal(queryOk('census-geocoder', ok.replace('json', 'html')), false);
  assert.equal(
    queryOk('census-geocoder', ok.replace('Public_AR_Current', '2020')),
    false,
  );
  assert.equal(queryOk('census-geocoder', `${ok}&vintage=Current_Current`), false);
  assert.equal(queryOk('census-geocoder', `${ok}&address=x`), false);
  assert.equal(
    queryOk('census-geocoder', 'benchmark=Public_AR_Current&format=json'),
    false,
  );
  assert.equal(
    queryOk('census-geocoder', ok.replace(/address=[^&]+/, 'address=ab')),
    false,
  );
  assert.equal(
    queryOk('census-geocoder', ok.replace(/address=[^&]+/, `address=${'a'.repeat(201)}`)),
    false,
  );
  assert.equal(
    queryOk('census-geocoder', ok.replace(/address=[^&]+/, 'address=1%0A2+x')),
    false,
  );
  const f = feed('census-geocoder');
  assert.match(f.headers['user-agent'], /^Argus\//);
  assert.equal(f.inject, undefined);
  assert.ok(f.governor.ratePerMinute <= 30 && f.governor.creditBudget <= 1000);
  assert.ok(f.cache.ttlMs >= 60 * 60_000);
});

test('photon-reverse: one rounded point, one answer', () => {
  assert.equal(pathOk('photon-reverse', '/reverse'), true);
  assert.equal(pathOk('photon-reverse', '/api/'), false);
  assert.equal(
    queryOk('photon-reverse', qs(regionParams({ lat: 33.72, lon: -116.21 }))),
    true,
  );
  assert.equal(queryOk('photon-reverse', 'lat=33.72&lon=-116.2&limit=1'), false); // finer than 0.1
  assert.equal(queryOk('photon-reverse', 'lat=33.7&lon=-116.2&limit=5'), false);
  assert.equal(queryOk('photon-reverse', 'lat=33.7&lon=-116.2'), false);
  assert.equal(queryOk('photon-reverse', 'lat=95&lon=0&limit=1'), false);
  assert.equal(queryOk('photon-reverse', 'lat=33.7&lon=-116.2&limit=1&radius=9'), false);
  assert.ok(feed('photon-reverse').cache.ttlMs >= 60 * 60_000);
});

test('nominatim: what core sends passes (search, address bias, reverse); nothing else', () => {
  assert.equal(pathOk('nominatim', '/search'), true);
  assert.equal(pathOk('nominatim', '/reverse'), true);
  assert.equal(pathOk('nominatim', '/search.php'), false);
  assert.equal(pathOk('nominatim', '/lookup'), false);
  assert.equal(queryOk('nominatim', 'q=paris&format=json&limit=5'), true);
  const near = nominatimAddressParams('46211 Jackson street', {
    lat: 33.72,
    lon: -116.21,
  });
  assert.equal(queryOk('nominatim', qs(near)), true);
  assert.equal(queryOk('nominatim', 'lat=37.77&lon=-122.41&format=jsonv2&zoom=18'), true);
  assert.equal(
    queryOk('nominatim', qs(reverseQuery({ latitude: 33.7, longitude: -116.2 }))),
    true,
  );
  assert.equal(queryOk('nominatim', 'q=a&format=json&bounded=1'), false);
  assert.equal(queryOk('nominatim', 'q=a&format=xml'), false);
  assert.equal(queryOk('nominatim', 'q=a&limit=50'), false);
  assert.equal(queryOk('nominatim', 'q=a&viewbox=1,2,3'), false);
  assert.equal(queryOk('nominatim', 'q=a&email=x'), false);
  assert.equal(queryOk('nominatim', 'lat=1&format=json'), false);
  assert.equal(queryOk('nominatim', 'lat=1&lon=2&zoom=19'), false);
  assert.ok(feed('nominatim').cache.ttlMs >= 60 * 60_000);
});

test('radiobrowser also reaches the per-station listen counter, nothing more', () => {
  const uuid = '9617a958-0601-11e8-ae97-52543be04c81';
  assert.equal(pathOk('radiobrowser', '/json/stations/search'), true);
  assert.equal(pathOk('radiobrowser', `/json/url/${uuid}`), true);
  assert.equal(pathOk('radiobrowser', '/json/url/not-a-uuid'), false);
  assert.equal(pathOk('radiobrowser', `/json/url/${uuid}/x`), false);
  assert.equal(pathOk('radiobrowser', '/json/stations/byuuid'), false);
});

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

test('a route request crosses the relay with its stops intact', async (t) => {
  const seen = [];
  const upstream = await listen((req, res) => {
    seen.push({ url: req.url, ua: req.headers['user-agent'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"code":"Ok","routes":[]}');
  });
  const osrm = { ...feed('osrm'), baseUrl: base(upstream) };
  const proxy = await listen(
    createRequestHandler({ config: loadConfig({}), feeds: [osrm], tokenManagers: {} }),
  );
  t.after(() => {
    upstream.close();
    proxy.close();
  });
  const path =
    '/routed-foot/route/v1/foot/-0.1278,51.5074;-0.1,51.52?overview=full&geometries=geojson&alternatives=false&steps=true';
  const res = await fetch(`${base(proxy)}/feed/osrm${path}`);
  assert.equal(res.status, 200);
  assert.equal(seen[0].url, path);
  assert.match(seen[0].ua, /^Argus\//);
  const far = await fetch(
    `${base(proxy)}/feed/osrm/routed-car/route/v1/driving/-0.13,51.5;-3.7,40.4?geometries=geojson`,
  );
  assert.equal(far.status, 403);
  const badQuery = await fetch(
    `${base(proxy)}/feed/osrm/routed-car/route/v1/driving/-0.13,51.5;-0.1,51.52?geometries=polyline`,
  );
  assert.equal(badQuery.status, 403);
  assert.equal(seen.length, 1);
});

// --- Valhalla, TomTom Routing and TomTom Search: exactly what core/nav builds ---

/** Whether the feed admits a request as core/nav builds it ({ feed, path, params }). */
function admits(req) {
  const f = feed(req.feed);
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(req.params ?? {})) q.set(k, String(v));
  const target = buildUpstreamUrl(f, req.path, `?${q}`);
  return (
    f.allowPaths.some((re) => re.test(target.pathname)) &&
    f.allowQuery(target.searchParams)
  );
}

const A = { lat: 37.7749, lon: -122.4194 };
const B = { lat: 37.7599, lon: -122.4148 };

test('valhalla: every request core sends passes; other shapes do not', () => {
  for (const mode of ['drive', 'walk', 'bike'])
    for (const avoidHighways of [false, true])
      for (const heading of [null, 359.6, 12])
        assert.equal(
          admits(nav.valhalla.request(A, B, { mode, avoidHighways, heading })),
          true,
        );
  const ok = JSON.parse(nav.valhalla.request(A, B, { avoidHighways: true }).params.json);
  const bad = (patch) => valhallaQueryOk(JSON.stringify({ ...ok, ...patch }));
  assert.equal(bad({}), true);
  assert.equal(
    bad({ locations: [...ok.locations, ok.locations[1]] }),
    false,
    'three stops',
  );
  assert.equal(
    bad({ locations: [ok.locations[0], { lat: 40.4, lon: -3.7 }] }),
    false,
    'too far',
  );
  assert.equal(bad({ locations: [{ lat: 91, lon: 0 }, ok.locations[1]] }), false);
  assert.equal(bad({ costing: 'truck' }), false);
  assert.equal(bad({ costing: 'pedestrian' }), false, 'use_highways is for driving');
  assert.equal(
    bad({ costing_options: { auto: { use_highways: 0, top_speed: 300 } } }),
    false,
  );
  assert.equal(bad({ alternates: 5 }), false);
  assert.equal(bad({ directions_options: { units: 'miles' } }), false);
  assert.equal(bad({ id: 'x' }), false);
  assert.equal(
    bad({ locations: [{ ...ok.locations[0], heading: 400 }, ok.locations[1]] }),
    false,
  );
  assert.equal(valhallaQueryOk('{not json'), false);
  assert.equal(valhallaQueryOk('x'.repeat(2000)), false);
  assert.equal(pathOk('valhalla', '/route'), true);
  assert.equal(pathOk('valhalla', '/sources_to_targets'), false);
  assert.equal(pathOk('valhalla', '/isochrone'), false);
  const one = encodeURIComponent(JSON.stringify(ok));
  assert.equal(queryOk('valhalla', `json=${one}`), true);
  assert.equal(queryOk('valhalla', `json=${one}&json=1`), false);
  const f = feed('valhalla');
  assert.match(f.headers['user-agent'], /^Argus\//);
  assert.equal(f.inject, undefined, 'keyless');
  assert.ok(f.governor.ratePerMinute <= 30 && f.cache.ttlMs >= 60_000);
});

test('osrm: the alternatives core asks for now pass', () => {
  for (const mode of ['drive', 'walk', 'bike'])
    assert.equal(admits(nav.osrm.request(A, B, { mode })), true);
});

test('tomtom-routing: what core sends passes; the key is injected, budgeted', () => {
  for (const mode of ['drive', 'walk', 'bike'])
    for (const avoidHighways of [false, true])
      for (const traffic of [true, false])
        assert.equal(
          admits(
            nav.tomtom.request(A, B, { mode, avoidHighways, traffic, heading: 270.4 }),
          ),
          true,
        );
  const req = nav.tomtom.request(A, B, {});
  assert.equal(
    admits({ ...req, path: '/calculateRoute/51.5,-0.13:40.4,-3.7/json' }),
    false,
    'leg over 600 km',
  );
  assert.equal(
    admits({ ...req, path: '/calculateRoute/1,1:2,2:3,3/json' }),
    false,
    'via points',
  );
  assert.equal(admits({ ...req, path: '/calculateReachableRange/1,1/json' }), false);
  assert.equal(admits({ ...req, params: { ...req.params, key: 'mine' } }), false);
  assert.equal(
    admits({ ...req, params: { ...req.params, maxAlternatives: '5' } }),
    false,
  );
  assert.equal(admits({ ...req, params: { ...req.params, avoid: 'tollRoads' } }), false);
  const f = feed('tomtom-routing');
  assert.deepEqual(f.inject, [{ secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' }]);
  let t = 0;
  const gov = createGovernor([f], () => t);
  let granted = 0;
  for (let i = 0; i < 260; i += 1) {
    t += 7000;
    if (gov.acquire('tomtom-routing', '/x').ok) granted += 1;
  }
  assert.equal(granted, 200);
});

test('tomtom-search: what core sends passes; nothing else', () => {
  for (const q of ['ferry building', 'Zürich HB', '1600 Amphitheatre Pkwy', 'a/b?c#d'])
    for (const near of [null, { lat: 37.78123, lon: -122.41 }])
      assert.equal(admits(tomtomSearchRequest(q, near, 8)), true, q);
  const req = tomtomSearchRequest('cafe', { lat: 1, lon: 2 });
  assert.equal(admits({ ...req, params: { ...req.params, radius: '100' } }), false);
  assert.equal(admits({ ...req, params: { ...req.params, limit: '100' } }), false);
  const halfBias = { ...req.params };
  delete halfBias.lon;
  assert.equal(admits({ ...req, params: halfBias }), false, 'half a bias');
  assert.equal(admits({ ...req, path: '/nearbySearch/.json' }), false);
  assert.equal(admits({ ...req, path: '/search/a/b.json' }), false);
  assert.deepEqual(feed('tomtom-search').inject, [
    { secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' },
  ]);
  assert.equal(feed('tomtom-search').governor.creditBudget, 250);
});

test('TomTom routing through the relay: key server side, 502 without it', async (t) => {
  const seen = [];
  const upstream = await listen((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"routes":[]}');
  });
  const local = {
    ...feed('tomtom-routing'),
    baseUrl: `http://127.0.0.1:${upstream.address().port}/routing/1`,
  };
  const proxy = await listen(
    createRequestHandler({ config: loadConfig({}), feeds: [local], tokenManagers: {} }),
  );
  const saved = process.env.TOMTOM_API_KEY;
  t.after(() => {
    upstream.close();
    proxy.close();
    if (saved === undefined) delete process.env.TOMTOM_API_KEY;
    else process.env.TOMTOM_API_KEY = saved;
  });
  const req = nav.tomtom.request(A, B, {});
  const url = `${base(proxy)}/feed/tomtom-routing${req.path}?${new URLSearchParams(req.params)}`;
  delete process.env.TOMTOM_API_KEY;
  assert.equal((await fetch(url)).status, 502);
  process.env.TOMTOM_API_KEY = 'tt-secret';
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const sent = new URL(seen[0], 'http://x');
  assert.equal(
    sent.pathname,
    '/routing/1/calculateRoute/37.7749,-122.4194:37.7599,-122.4148/json',
  );
  assert.equal(sent.searchParams.get('key'), 'tt-secret');
  assert.equal(sent.searchParams.get('computeTravelTimeFor'), 'all');
});
