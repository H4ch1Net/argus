import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenManager } from '../lib/oauth.js';

// A fake fetch so token-manager logic is tested without real sockets or time.
// Each call returns an incrementing token unless `respond` overrides.
function fakeFetch(respond) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = respond ? respond(calls.length) : { status: 200 };
    const status = r.status ?? 200;
    const bodyObj = r.body ?? { access_token: `tok-${calls.length}`, expires_in: 1800 };
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return bodyObj;
      },
    };
  };
  fn.calls = calls;
  return fn;
}

test('caches the token and only refetches near expiry', async () => {
  let clock = 1_000_000;
  const fetchImpl = fakeFetch();
  const mgr = createTokenManager({
    tokenUrl: 'https://auth/token',
    clientId: 'id',
    clientSecret: 'secret',
    now: () => clock,
    refreshSkewMs: 30_000,
    fetchImpl,
  });

  assert.equal(await mgr.getToken(), 'tok-1');
  assert.equal(await mgr.getToken(), 'tok-1'); // cached
  assert.equal(fetchImpl.calls.length, 1);

  clock += (1800 - 20) * 1000; // within skew of expiry
  assert.equal(await mgr.getToken(), 'tok-2');
  assert.equal(fetchImpl.calls.length, 2);
});

test('single-flights concurrent refreshes into one fetch', async () => {
  const fetchImpl = fakeFetch();
  const mgr = createTokenManager({
    tokenUrl: 'https://auth/token',
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl,
  });
  const tokens = await Promise.all([mgr.getToken(), mgr.getToken(), mgr.getToken()]);
  assert.deepEqual(tokens, ['tok-1', 'tok-1', 'tok-1']);
  assert.equal(fetchImpl.calls.length, 1);
});

test('invalidate forces a refetch', async () => {
  const fetchImpl = fakeFetch();
  const mgr = createTokenManager({
    tokenUrl: 'https://auth/token',
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl,
  });
  assert.equal(await mgr.getToken(), 'tok-1');
  mgr.invalidate();
  assert.equal(await mgr.getToken(), 'tok-2');
  assert.equal(fetchImpl.calls.length, 2);
});

test('throws on a non-200 token response', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 401 }));
  const mgr = createTokenManager({
    tokenUrl: 'https://auth/token',
    clientId: 'id',
    clientSecret: 'secret',
    fetchImpl,
  });
  await assert.rejects(() => mgr.getToken(), /returned 401/);
});

test('falls back to a 30-min ttl when expires_in is absent', async () => {
  let clock = 0;
  const fetchImpl = fakeFetch(() => ({ status: 200, body: { access_token: 'x' } }));
  const mgr = createTokenManager({
    tokenUrl: 'https://auth/token',
    clientId: 'id',
    clientSecret: 'secret',
    now: () => clock,
    fetchImpl,
  });
  await mgr.getToken();
  assert.equal(mgr.peek().expiresAt, 1800 * 1000);
});

test('POSTs client_credentials with id/secret form-encoded', async () => {
  const fetchImpl = fakeFetch();
  const mgr = createTokenManager({
    tokenUrl: 'https://auth/token',
    clientId: 'my-id',
    clientSecret: 'my-secret',
    fetchImpl,
  });
  await mgr.getToken();
  const { opts } = fetchImpl.calls[0];
  assert.equal(opts.method, 'POST');
  assert.match(opts.headers['content-type'], /application\/x-www-form-urlencoded/);
  const params = new URLSearchParams(opts.body);
  assert.equal(params.get('grant_type'), 'client_credentials');
  assert.equal(params.get('client_id'), 'my-id');
  assert.equal(params.get('client_secret'), 'my-secret');
});
