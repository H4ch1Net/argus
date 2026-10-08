import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { feeds } from '../feeds.js';
import { osrmStopsAllowed } from '../feeds/nav.js';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';

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
