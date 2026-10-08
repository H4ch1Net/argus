import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateFeeds } from '../lib/config.js';

test('loadConfig defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8787);
  assert.equal(c.https, false);
  assert.equal(c.cors.allowAnyOrigin, true);
  assert.equal(c.timeoutMs, 15000);
});

test('loadConfig honors env overrides', () => {
  const c = loadConfig({
    PROXY_PORT: '9000',
    PROXY_HTTPS: 'true',
    PROXY_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    PROXY_UPSTREAM_TIMEOUT_MS: '5000',
  });
  assert.equal(c.port, 9000);
  assert.equal(c.https, true);
  assert.equal(c.cors.allowAnyOrigin, false);
  assert.deepEqual(c.cors.origins, ['https://a.example', 'https://b.example']);
  assert.equal(c.timeoutMs, 5000);
});

test('validateFeeds rejects duplicate ids and bad URLs', () => {
  assert.throws(() =>
    validateFeeds([
      { id: 'a', baseUrl: 'https://x/' },
      { id: 'a', baseUrl: 'https://y/' },
    ]),
  );
  assert.throws(() => validateFeeds([{ id: 'a', baseUrl: 'not a url' }]));
  assert.throws(() => validateFeeds([{ baseUrl: 'https://x/' }]));
  assert.deepEqual(validateFeeds([]), []);
});

test('the real feed registry validates and pins the keyless flights fallback', async () => {
  const { feeds } = await import('../feeds.js');
  assert.equal(validateFeeds(feeds), feeds);
  const adsb = feeds.find((f) => f.id === 'adsblol');
  const allowed = (p) => adsb.allowPaths.some((re) => re.test(p));
  assert.equal(allowed('/v2/lat/37.5/lon/-122.5/dist/42'), true);
  assert.equal(allowed('/v2/lat/-33.75/lon/151.25/dist/250'), true);
  assert.equal(allowed('/v2/mil'), true);
  // Only the viewport area query and the military list, nothing else on that host.
  assert.equal(allowed('/v2/hex/abc123'), false);
  assert.equal(allowed('/v2/callsign/X'), false);
  assert.equal(allowed('/v2/lat/1/lon/2/dist/3/extra'), false);
  assert.equal(adsb.inject, undefined); // keyless: no secret involved
});

test('every ported feed is keyless or optional-keyed and path-pinned', async () => {
  const { feeds } = await import('../feeds.js');
  const { buildUpstreamUrl } = await import('../lib/relay.js');
  const ids = ['radiobrowser', 'll2', 'nhc', 'nowcoast', 'cables'];
  const gtfs = feeds.filter((f) => f.id.startsWith('gtfsrt-'));
  assert.equal(gtfs.length, 7);
  for (const f of [...feeds.filter((x) => ids.includes(x.id)), ...gtfs]) {
    assert.ok(f.allowPaths?.length, `${f.id} has a path allowlist`);
    assert.ok(
      (f.inject || []).every((r) => r.required === false),
      `${f.id} needs no key`,
    );
    assert.match(f.headers['user-agent'], /^Argus\/.+github\.com/);
  }
  // A GTFS-RT feed reaches exactly its one file (CapMetro's path has an encoded slash).
  const cap = feeds.find((f) => f.id === 'gtfsrt-capmetro');
  const target = buildUpstreamUrl(cap, '/application%2Foctet-stream', '');
  assert.ok(cap.allowPaths[0].test(target.pathname));
  assert.equal(cap.allowPaths[0].test(target.pathname + 'x'), false);
  const entur = feeds.find((f) => f.id === 'gtfsrt-entur');
  assert.ok(entur.headers['et-client-name']);
  // nowCOAST: only the three observation WMS services.
  const nc = feeds.find((f) => f.id === 'nowcoast').allowPaths[0];
  assert.ok(nc.test('/geoserver/observations/satellite/ows'));
  assert.equal(nc.test('/geoserver/observations/satellite/wfs'), false);
  // Overpass can be re-pointed by the operator, and still only reaches /interpreter.
  const ovp = feeds.find((f) => f.id === 'overpass');
  assert.equal(ovp.baseUrlEnv, 'OVERPASS_URL');
  assert.ok(ovp.allowPaths[0].test('/osm/api/interpreter'));
  assert.equal(ovp.allowPaths[0].test('/api/status'), false);
});
