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
