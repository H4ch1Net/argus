import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig, validateFeeds } from '../lib/config.js';
import { createResponseCache } from '../lib/cache.js';
import { createLimiter, orderByHealth, upstreamBases } from '../lib/relay.js';
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

test('mirrors: 429, 5xx and timeouts move on, in order; a failed base is skipped a while', async (t) => {
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

test('mirror order: override first, then the feed base, then mirrors; cooling ones skipped', () => {
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
  // A base cooling down is skipped, not just moved back...
  const ab = ['https://a/api', 'https://b/api'];
  const health = new Map([['https://a/api', 2000]]);
  assert.deepEqual(orderByHealth(ab, health, 1000), ['https://b/api']);
  assert.deepEqual(orderByHealth(ab, health, 3000), ab, 'and back once cooled');
  // ...and when every one is cooling, one try at the first to recover.
  health.set('https://b/api', 1500);
  assert.deepEqual(orderByHealth(ab, health, 1000), ['https://b/api']);
  // A feed without mirrors always tries its one base.
  assert.deepEqual(orderByHealth(['https://a/api'], health, 1000), ['https://a/api']);
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

test('the limiter: a few at a time, the rest in order, bounded waits', async () => {
  const lim = createLimiter(2, { maxQueued: 2 });
  const r1 = await lim.acquire();
  await lim.acquire();
  const order = [];
  const third = lim.acquire().then((rel) => (order.push(3), rel));
  const fourth = lim.acquire().then((rel) => (order.push(4), rel));
  await assert.rejects(lim.acquire(), /queue full/);
  assert.equal(lim.active, 2);
  assert.equal(lim.queued, 2);
  r1();
  r1(); // releasing twice frees one slot only
  const r3 = await third;
  assert.deepEqual(order, [3]);
  r3();
  (await fourth)();
  assert.equal(lim.active, 1);
  // A wait that runs out, or a caller that leaves, gives up its place.
  const busy = createLimiter(1);
  await busy.acquire();
  await assert.rejects(busy.acquire({ maxWaitMs: 20 }), /timed out/);
  const ac = new AbortController();
  const left = busy.acquire({ signal: ac.signal });
  ac.abort();
  await assert.rejects(left, { name: 'AbortError' });
  assert.equal(busy.queued, 0);
});

test('a queued feed sends a burst two at a time and answers every request', async (t) => {
  let inFlight = 0;
  let peak = 0;
  const upstream = await listen((req, res) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ elements: [], url: req.url }));
    }, 60);
  });
  t.after(() => upstream.close());
  const proxy = await startProxy(t, [
    {
      id: 'ovp',
      baseUrl: `${base(upstream)}/api`,
      allowPaths: [/^\/api\/interpreter$/],
      queue: { concurrency: 2, maxWaitMs: 5_000 },
      cache: { ttlMs: 60_000 },
    },
  ]);
  const tiles = Array.from({ length: 8 }, (_, i) =>
    fetch(`${base(proxy)}/feed/ovp/interpreter?data=tile${i}`),
  );
  const answers = await Promise.all(tiles);
  assert.ok(answers.every((r) => r.status === 200));
  assert.equal(peak, 2, 'never more than two upstream at once');
});

test('identical requests in flight share one upstream call', async (t) => {
  const { server, state } = await startUpstream(t, {
    body: '{"elements":[1]}',
    delayMs: 120,
  });
  const proxy = await startProxy(t, [
    { id: 'f', baseUrl: base(server), cache: { ttlMs: 60_000 } },
  ]);
  const same = await Promise.all(
    [1, 2, 3].map(() => fetch(`${base(proxy)}/feed/f/interpreter?data=same`)),
  );
  assert.equal(state.hits.length, 1);
  assert.deepEqual(same.map((r) => r.headers.get('x-argus-cache')).sort(), [
    'hit',
    'hit',
    'miss',
  ]);
  // When the shared call fails, the others do not repeat it.
  state.plan = { status: 503, body: 'down', delayMs: 120 };
  const failed = await Promise.all(
    [1, 2, 3].map(() => fetch(`${base(proxy)}/feed/f/interpreter?data=other`)),
  );
  assert.equal(state.hits.length, 2);
  assert.ok(failed.every((r) => r.status >= 500));
});

test('a rate-limited queued feed waits for room instead of failing', async (t) => {
  const { server } = await startUpstream(t, { body: 'ok' });
  let calls = 0;
  const governor = {
    acquire: () =>
      ++calls === 1
        ? { ok: false, status: 429, message: 'rate limit for q', retryAfterMs: 40 }
        : { ok: true, cost: 0 },
    refund: () => {},
    usage: () => null,
  };
  const feeds = [
    { id: 'q', baseUrl: base(server), queue: { concurrency: 1, maxWaitMs: 2_000 } },
    { id: 'plain', baseUrl: base(server) },
  ];
  const proxy = await listen(
    createRequestHandler({ config: loadConfig({}), feeds, governor }),
  );
  t.after(() => proxy.close());
  const r = await fetch(`${base(proxy)}/feed/q/x`);
  assert.equal(r.status, 200);
  assert.equal(calls, 2);
  // Without a queue, a refusal is immediate, as before.
  calls = 0;
  assert.equal((await fetch(`${base(proxy)}/feed/plain/x`)).status, 429);
});

test('when every instance fails, the next request tries just one', async (t) => {
  const a = await startUpstream(t, { status: 503 });
  const b = await startUpstream(t, { status: 429 });
  const proxy = await startProxy(t, [
    {
      id: 'm',
      baseUrl: `${base(a.server)}/api`,
      mirrors: [`${base(b.server)}/api`],
      allowPaths: [/^\/api\/interpreter$/],
    },
  ]);
  assert.equal((await fetch(`${base(proxy)}/feed/m/interpreter?data=1`)).status, 429);
  assert.equal(a.state.hits.length + b.state.hits.length, 2, 'each once');
  await fetch(`${base(proxy)}/feed/m/interpreter?data=2`);
  assert.equal(a.state.hits.length + b.state.hits.length, 3, 'then one try, not two');
});
