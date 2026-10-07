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
  assert.equal(allowed('/v2/point/37.5/-122.5/42'), true);
  assert.equal(allowed('/v2/point/-33.9/151.2/250'), true);
  // Only the viewport point query is reachable, nothing else on that host.
  assert.equal(allowed('/v2/mil'), false);
  assert.equal(allowed('/v2/point/1/2/3/extra'), false);
  assert.equal(adsb.inject, undefined); // keyless: no secret involved
});
