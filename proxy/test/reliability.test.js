import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig, validateFeeds } from '../lib/config.js';
import { createResponseCache } from '../lib/cache.js';
import { orderByHealth, upstreamBases } from '../lib/relay.js';
import { feeds as registry, OVERPASS_MIRRORS, overpassAnswered } from '../feeds.js';
import { chpDocumentComplete } from '../feeds/traffic.js';

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

/** An upstream whose behaviour the test sets: { status, body, delayMs } per request. */
async function startUpstream(t, plan) {
  const state = { hits: [], plan };
  const server = await listen((req, res) => {
    state.hits.push({ url: req.url, connection: req.headers.connection });
    const step =
      typeof state.plan === 'function' ? state.plan(state.hits.length) : state.plan;
    setTimeout(() => {
      res.writeHead(step.status ?? 200, { 'content-type': step.type ?? 'text/plain' });
      res.end(step.body ?? 'ok');
    }, step.delayMs ?? 0);
  });
  t.after(() => server.close());
  return { server, state };
}

async function startProxy(t, feeds, env = {}) {
  const proxy = await listen(createRequestHandler({ config: loadConfig(env), feeds }));
  t.after(() => proxy.close());
  return proxy;
}

test('a stale answer says how old it is', async (t) => {
  const { server, state } = await startUpstream(t, { body: 'good' });
  const proxy = await startProxy(t, [
    { id: 'f', baseUrl: base(server), cache: { ttlMs: 0, staleMs: 60_000 } },
  ]);
  assert.equal(await (await fetch(`${base(proxy)}/feed/f/x`)).text(), 'good');
  state.plan = { status: 502, body: 'bad gateway' };
  const r = await fetch(`${base(proxy)}/feed/f/x`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'good');
  assert.equal(r.headers.get('x-argus-cache'), 'stale');
  assert.equal(r.headers.get('x-argus-stale'), '0');
  // A fresh answer carries no stale mark.
  state.plan = { body: 'new' };
  const fresh = await fetch(`${base(proxy)}/feed/f/x`);
  assert.equal(fresh.headers.get('x-argus-stale'), null);
});

test('a timeout serves the last good body too, and each feed has its own timeout', async (t) => {
  const { server, state } = await startUpstream(t, { body: 'v1' });
  const proxy = await startProxy(
    t,
    [
      { id: 'quick', baseUrl: base(server), cache: { ttlMs: 0, staleMs: 60_000 } },
      { id: 'patient', baseUrl: base(server), timeoutMs: 1_000 },
    ],
    { PROXY_UPSTREAM_TIMEOUT_MS: '60' },
  );
  await fetch(`${base(proxy)}/feed/quick/x`);
  state.plan = { body: 'late', delayMs: 200 };
  const stale = await fetch(`${base(proxy)}/feed/quick/x`);
  assert.equal(await stale.text(), 'v1');
  assert.equal(stale.headers.get('x-argus-cache'), 'stale');
  // Same delay, longer per-feed timeout: answered.
  const patient = await fetch(`${base(proxy)}/feed/patient/x`);
  assert.equal(await patient.text(), 'late');
  // No cache to fall back on: the error names the timeout.
  const proxy2 = await startProxy(t, [{ id: 'q', baseUrl: base(server) }], {
    PROXY_UPSTREAM_TIMEOUT_MS: '60',
  });
  const r = await fetch(`${base(proxy2)}/feed/q/x`);
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /timed out after 0\.1 s/);
});

test('mirrors: 429, 5xx and timeouts move on, in order; a failed base cools down', async (t) => {
  const main = await startUpstream(t, { status: 429, body: 'busy' });
  const second = await startUpstream(t, { body: 'slow', delayMs: 300 });
  const third = await startUpstream(t, {
    body: '{"elements":[1]}',
    type: 'application/json',
  });
  const feeds = [
    {
      id: 'ovp',
      baseUrl: `${base(main.server)}/api`,
      mirrors: [`${base(second.server)}/mirror/api`, `${base(third.server)}/x/api`],
      allowPaths: [/^\/api\/interpreter$/],
      timeoutMs: 100,
      cache: { ttlMs: 60_000 },
    },
  ];
  const proxy = await startProxy(t, feeds);
  const r = await fetch(`${base(proxy)}/feed/ovp/interpreter?data=q1`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '{"elements":[1]}');
  assert.equal(r.headers.get('x-argus-upstream'), '127.0.0.1');
  assert.equal(main.state.hits[0].url, '/api/interpreter?data=q1');
  assert.equal(second.state.hits[0].url, '/mirror/api/interpreter?data=q1');
  assert.equal(third.state.hits[0].url, '/x/api/interpreter?data=q1');
  // Cached under the request, whichever instance answered.
  const again = await fetch(`${base(proxy)}/feed/ovp/interpreter?data=q1`);
  assert.equal(again.headers.get('x-argus-cache'), 'hit');
  // The two failed bases now wait at the back: a new query goes to the third first.
  await fetch(`${base(proxy)}/feed/ovp/interpreter?data=q2`);
  assert.equal(third.state.hits.length, 2);
  assert.equal(main.state.hits.length, 1);
  assert.equal(second.state.hits.length, 1);
  // The mirrors' paths are still judged against the feed's own allowlist.
  assert.equal((await fetch(`${base(proxy)}/feed/ovp/status`)).status, 403);
});

test('mirror order: override first, then the feed base, then mirrors; cooling ones last', () => {
  const feed = { baseUrl: 'https://a/api', mirrors: ['https://b/api', 'https://c/api'] };
  assert.deepEqual(upstreamBases(feed, { baseUrl: 'https://a/api', overridden: false }), [
    'https://a/api',
    'https://b/api',
    'https://c/api',
  ]);
  assert.deepEqual(upstreamBases(feed, { baseUrl: 'https://me/api', overridden: true }), [
    'https://me/api',
    'https://a/api',
    'https://b/api',
    'https://c/api',
  ]);
  // No mirrors: an override still replaces the base.
  assert.deepEqual(
    upstreamBases(
      { baseUrl: 'https://a/api' },
      { baseUrl: 'https://me', overridden: true },
    ),
    ['https://me'],
  );
  const health = new Map([['https://a/api', 2000]]);
  assert.deepEqual(orderByHealth(['https://a/api', 'https://b/api'], health, 1000), [
    'https://b/api',
    'https://a/api',
  ]);
  assert.deepEqual(orderByHealth(['https://a/api', 'https://b/api'], health, 3000), [
    'https://a/api',
    'https://b/api',
  ]);
});

test('the Overpass entry: env override, main instance, two mirrors, long cache', () => {
  const ovp = registry.find((f) => f.id === 'overpass');
  assert.equal(ovp.baseUrlEnv, 'OVERPASS_URL');
  assert.equal(ovp.baseUrl, 'https://overpass-api.de/api');
  assert.deepEqual(ovp.mirrors, OVERPASS_MIRRORS);
  assert.deepEqual(OVERPASS_MIRRORS, [
    'https://maps.mail.ru/osm/tools/overpass/api',
    'https://overpass.kumi.systems/api',
  ]);
  assert.ok(ovp.cache.ttlMs >= 12 * 3600_000);
  assert.ok(ovp.timeoutMs > 25_000, 'longer than the [timeout:25] the queries ask for');
  assert.ok(!ovp.inject && !ovp.auth);
  // A query that ran out of time on the server is not an answer...
  const timedOut = Buffer.from(
    '{\n  "version": 0.6,\n  "elements": [\n\n  ],\n"remark": "runtime error: Query timed out in \\"query\\" at line 1 after 2 seconds."\n}\n',
  );
  assert.equal(overpassAnswered(timedOut), false);
  assert.equal(
    overpassAnswered(
      Buffer.from('<osm><remark> runtime error: out of memory </remark></osm>'),
    ),
    false,
  );
  // ...an ordinary one is.
  assert.equal(
    overpassAnswered(Buffer.from('{"elements":[{"type":"node","id":1}]}')),
    true,
  );
});

test('validate: a cut document is retried on a fresh connection and never cached', async (t) => {
  const xml = fs.readFileSync(
    new URL('../../core/layers/chp/fixtures/sa-sample.xml', import.meta.url),
  );
  const cut = xml.subarray(0, 4000);
  const { server, state } = await startUpstream(t, (n) => ({
    body: n % 2 ? cut : xml,
    type: 'text/xml',
  }));
  const chp = registry.find((f) => f.id === 'chp-cad');
  const feeds = [
    {
      ...chp,
      id: 'chp',
      baseUrl: `${base(server)}/sa_xml`,
      baseUrlEnv: undefined,
      governor: undefined,
    },
  ];
  const proxy = await startProxy(t, feeds);
  const r = await fetch(`${base(proxy)}/feed/chp/sa.xml`);
  assert.equal(r.status, 200);
  assert.equal(
    (await r.arrayBuffer()).byteLength,
    xml.length,
    'the second try was whole',
  );
  assert.equal(state.hits.length, 2);
  assert.ok(state.hits.every((h) => h.connection === 'close'));
  assert.equal(state.hits[0].url, '/sa_xml/sa.xml');

  // Only cut copies: the last good one stands in, marked stale.
  state.plan = { body: cut, type: 'text/xml' };
  const stale = await fetch(`${base(proxy)}/feed/chp/sa.xml?`);
  assert.equal(stale.headers.get('x-argus-cache'), 'hit', 'still fresh for a minute');
  const proxy2 = await startProxy(t, [{ ...feeds[0], cache: undefined }]);
  const passed = await fetch(`${base(proxy2)}/feed/chp/sa.xml`);
  assert.equal(passed.status, 200, 'nothing better: the cut copy is passed on');
  assert.equal(passed.headers.get('x-argus-invalid'), '1');
  assert.equal((await passed.arrayBuffer()).byteLength, cut.length);
  assert.equal(state.hits.length, 5, 'three tries: once and two retries');

  assert.equal(chpDocumentComplete(xml), true);
  assert.equal(chpDocumentComplete(cut), false);
  assert.equal(chpDocumentComplete(Buffer.from('<State></State>\r\n')), true);
});

test('a cut answer is never cached: the next request goes upstream again', async (t) => {
  const { server, state } = await startUpstream(t, { body: '<State>' });
  const proxy = await startProxy(t, [
    {
      id: 'v',
      baseUrl: base(server),
      validate: (b) => b.toString().endsWith('</State>'),
      cache: { ttlMs: 60_000 },
    },
  ]);
  await fetch(`${base(proxy)}/feed/v/x`);
  const second = await fetch(`${base(proxy)}/feed/v/x`);
  assert.equal(second.headers.get('x-argus-cache'), 'miss');
  assert.equal(state.hits.length, 2);
});

test('validateFeeds: mirrors carry no secrets and are https; produce is GET-only', () => {
  const ok = { id: 'm', baseUrl: 'https://a/api', mirrors: ['https://b/api'] };
  assert.deepEqual(validateFeeds([ok]), [ok]);
  assert.throws(
    () => validateFeeds([{ ...ok, inject: [{ secret: 'K', as: 'query', name: 'k' }] }]),
    /mirrors/,
  );
  assert.throws(() => validateFeeds([{ ...ok, mirrors: ['http://b/api'] }]), /mirror/);
  assert.throws(() => validateFeeds([{ ...ok, localOnly: true }]), /mirrors/);
  assert.throws(() => validateFeeds([{ id: 'p', baseUrl: 'https://a', produce: 'x' }]));
  assert.throws(() => validateFeeds([{ id: 't', baseUrl: 'https://a', timeoutMs: 0 }]));
  // The real registry passes.
  assert.equal(validateFeeds(registry), registry);
});

test('the cache bounds a feed by bytes as well as entries', () => {
  const cache = createResponseCache({ maxBytes: 1000 });
  const put = (k, n, opts) =>
    cache.set(k, { status: 200, headers: {}, body: Buffer.alloc(n) }, opts);
  put('other', 100, { group: 'b' });
  for (let i = 0; i < 5; i += 1) put(`t${i}`, 60, { group: 'a', groupMaxBytes: 150 });
  assert.equal(cache.get('t4', 1e9)?.body.length, 60);
  assert.equal(cache.get('t3', 1e9)?.body.length, 60);
  assert.equal(cache.get('t2', 1e9), null, 'its own oldest went');
  assert.ok(cache.get('other', 1e9), "another feed's entry stays");
});

test('a fetch that refuses the Connection header still gets the request', async (t) => {
  const { server, state } = await startUpstream(t, { body: '<State></State>' });
  const proxy = await startProxy(t, [
    { id: 'c', baseUrl: base(server), freshConnection: true },
  ]);
  // The relay's fetch behaves like an older undici that throws on a
  // Connection header; the test's own requests use the real one.
  const real = globalThis.fetch;
  globalThis.fetch = (url, opts) =>
    opts?.headers?.connection
      ? Promise.reject(new TypeError('invalid connection header'))
      : real(url, opts);
  t.after(() => {
    globalThis.fetch = real;
  });
  const r = await real(`${base(proxy)}/feed/c/sa.xml`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '<State></State>');
  assert.equal(state.hits.length, 1);
  assert.notEqual(state.hits[0].connection, 'close');
});
