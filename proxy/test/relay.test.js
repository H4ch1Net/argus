import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { buildUpstreamUrl, isPrivateHost, RelayError } from '../lib/relay.js';

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const base = (s) => `http://127.0.0.1:${s.address().port}`;

// Raw GET that sends the path verbatim (fetch would reject a malformed path).
function rawStatus(server, path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path, method: 'GET' },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// An echo upstream that reports what the proxy actually sent it.
function startEcho() {
  return listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'max-age=42',
      });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          authorization: req.headers['authorization'] || null,
          accept: req.headers['accept'] || null,
          body,
        }),
      );
    });
  });
}

async function startProxy(feeds, env = {}, tokenManagers = {}) {
  const config = loadConfig(env);
  const server = await listen(createRequestHandler({ config, feeds, tokenManagers }));
  return server;
}

test('relay forwards sub-path + query, injects secret header, passes CORS and content-type', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [
    {
      id: 'echo',
      baseUrl: `${base(echo)}/api`,
      methods: ['GET'],
      inject: [
        {
          secret: 'ECHO_TOKEN',
          as: 'header',
          name: 'Authorization',
          template: 'Bearer {value}',
        },
      ],
    },
  ];
  process.env.ECHO_TOKEN = 's3cret';
  const proxy = await startProxy(feeds, {});
  t.after(() => {
    proxy.close();
    delete process.env.ECHO_TOKEN;
  });

  const r = await fetch(`${base(proxy)}/feed/echo/states/all?lamin=1`, {
    headers: { origin: 'https://app.example', accept: 'application/json' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://app.example');
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.equal(r.headers.get('cache-control'), 'max-age=42');

  const j = await r.json();
  assert.equal(j.method, 'GET');
  assert.equal(j.url, '/api/states/all?lamin=1'); // base path kept, query forwarded
  assert.equal(j.authorization, 'Bearer s3cret'); // secret injected server side
  assert.equal(j.accept, 'application/json');
});

test('query-injected secret is appended, not exposed to client config', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [
    {
      id: 'echo',
      baseUrl: `${base(echo)}/`,
      inject: [{ secret: 'API_KEY', as: 'query', name: 'key' }],
    },
  ];
  process.env.API_KEY = 'abc123';
  const proxy = await startProxy(feeds, {});
  t.after(() => {
    proxy.close();
    delete process.env.API_KEY;
  });

  const r = await fetch(`${base(proxy)}/feed/echo/data?x=1`);
  const j = await r.json();
  assert.match(j.url, /[?&]key=abc123/);
  assert.match(j.url, /[?&]x=1/);
});

test('unknown feed -> 404', async (t) => {
  const proxy = await startProxy([], {});
  t.after(() => proxy.close());
  const r = await fetch(`${base(proxy)}/feed/nope/x`);
  assert.equal(r.status, 404);
});

test('disallowed method -> 405', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [{ id: 'echo', baseUrl: `${base(echo)}/`, methods: ['GET'] }];
  const proxy = await startProxy(feeds, {});
  t.after(() => proxy.close());
  const r = await fetch(`${base(proxy)}/feed/echo/x`, { method: 'POST' });
  assert.equal(r.status, 405);
});

test('missing required secret -> 502 (feed not configured)', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [
    {
      id: 'echo',
      baseUrl: `${base(echo)}/`,
      inject: [{ secret: 'ABSENT_SECRET', as: 'header', name: 'Authorization' }],
    },
  ];
  const proxy = await startProxy(feeds, {});
  t.after(() => proxy.close());
  const r = await fetch(`${base(proxy)}/feed/echo/x`);
  assert.equal(r.status, 502);
});

test('path allowlist blocks a non-listed sub-path -> 403', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [
    { id: 'echo', baseUrl: `${base(echo)}/api`, allowPaths: [/^\/api\/states\//] },
  ];
  const proxy = await startProxy(feeds, {});
  t.after(() => proxy.close());
  assert.equal((await fetch(`${base(proxy)}/feed/echo/states/all`)).status, 200);
  assert.equal((await fetch(`${base(proxy)}/feed/echo/secret/thing`)).status, 403);
});

test('malformed feed id -> 400', async (t) => {
  const proxy = await startProxy([], {});
  t.after(() => proxy.close());
  // Incomplete percent-escape: decodeURIComponent throws, must map to 400.
  const status = await rawStatus(proxy, '/feed/%E0%A4%A/x');
  assert.equal(status, 400);
});

test('slow upstream body aborts on timeout -> 502', async (t) => {
  const slow = await listen((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('late');
    }, 400);
  });
  t.after(() => slow.close());
  const feeds = [{ id: 'slow', baseUrl: `${base(slow)}/` }];
  const proxy = await startProxy(feeds, { PROXY_UPSTREAM_TIMEOUT_MS: '50' });
  t.after(() => proxy.close());
  const r = await fetch(`${base(proxy)}/feed/slow/x`);
  assert.equal(r.status, 502);
});

test('oauth2 feed injects a brokered Bearer token', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [{ id: 'sky', baseUrl: `${base(echo)}/api`, auth: { type: 'oauth2' } }];
  const tokenManagers = { sky: { getToken: async () => 'brokered', invalidate() {} } };
  const proxy = await startProxy(feeds, {}, tokenManagers);
  t.after(() => proxy.close());

  const r = await fetch(`${base(proxy)}/feed/sky/states/all`);
  const j = await r.json();
  assert.equal(j.authorization, 'Bearer brokered');
});

test('oauth2 feed with no token manager -> 502 (unconfigured)', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [{ id: 'sky', baseUrl: `${base(echo)}/api`, auth: { type: 'oauth2' } }];
  const proxy = await startProxy(feeds, {}, {}); // no manager
  t.after(() => proxy.close());
  const r = await fetch(`${base(proxy)}/feed/sky/states/all`);
  assert.equal(r.status, 502);
});

test('a 401 triggers one token refresh and retry', async (t) => {
  // Upstream rejects the first (stale) token, accepts the second.
  let hits = 0;
  const upstream = await listen((req, res) => {
    hits += 1;
    if (req.headers['authorization'] === 'Bearer stale') {
      res.writeHead(401);
      res.end('expired');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, auth: req.headers['authorization'] }));
  });
  t.after(() => upstream.close());

  let issued = 0;
  const manager = {
    async getToken() {
      return issued === 0 ? 'stale' : 'fresh';
    },
    invalidate() {
      issued = 1;
    },
  };
  const feeds = [{ id: 'sky', baseUrl: `${base(upstream)}/`, auth: { type: 'oauth2' } }];
  const proxy = await startProxy(feeds, {}, { sky: manager });
  t.after(() => proxy.close());

  const r = await fetch(`${base(proxy)}/feed/sky/x`);
  assert.equal(r.status, 200);
  assert.equal(hits, 2); // first 401, retried once
  const j = await r.json();
  assert.equal(j.auth, 'Bearer fresh');
});

test('pathPrefix inject puts the secret in the URL path', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [
    {
      id: 'firms',
      baseUrl: `${base(echo)}/api/area/csv`,
      inject: [{ secret: 'FIRMS_KEY', as: 'pathPrefix' }],
    },
  ];
  process.env.FIRMS_KEY = 'mapkey123';
  const proxy = await startProxy(feeds, {});
  t.after(() => {
    proxy.close();
    delete process.env.FIRMS_KEY;
  });

  const r = await fetch(`${base(proxy)}/feed/firms/VIIRS_SNPP_NRT/-10,20,10,40/1`);
  const j = await r.json();
  assert.equal(j.url, '/api/area/csv/mapkey123/VIIRS_SNPP_NRT/-10,20,10,40/1');
});

test('pathPrefix feed with missing secret -> 502', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [
    {
      id: 'firms',
      baseUrl: `${base(echo)}/api/area/csv`,
      inject: [{ secret: 'ABSENT_FIRMS_KEY', as: 'pathPrefix' }],
    },
  ];
  const proxy = await startProxy(feeds, {});
  t.after(() => proxy.close());
  assert.equal((await fetch(`${base(proxy)}/feed/firms/x/y/1`)).status, 502);
});

test('buildUpstreamUrl refuses path traversal above the base path', () => {
  const feed = { id: 'x', baseUrl: 'https://up.example/api' };
  assert.throws(() => buildUpstreamUrl(feed, '/../../etc', ''), RelayError);
  // A normal sub-path resolves cleanly under the base path.
  const ok = buildUpstreamUrl(feed, '/states/all', '?q=1');
  assert.equal(ok.origin, 'https://up.example');
  assert.equal(ok.pathname, '/api/states/all');
  assert.equal(ok.search, '?q=1');
});

// An upstream whose status can be switched, counting the requests it receives.
async function startCounter() {
  const state = { hits: 0, status: 200 };
  const server = await listen((req, res) => {
    state.hits += 1;
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ n: state.hits, url: req.url }));
  });
  return { server, state };
}

test('a cached feed answers repeats from memory, uncached feeds always go upstream', async (t) => {
  const { server, state } = await startCounter();
  t.after(() => server.close());
  const feeds = [
    { id: 'slow', baseUrl: base(server), cache: { ttlMs: 60_000 } },
    { id: 'live', baseUrl: base(server) },
  ];
  const proxy = await startProxy(feeds);
  t.after(() => proxy.close());

  const a = await fetch(`${base(proxy)}/feed/slow/x?q=1`);
  assert.equal(a.headers.get('x-argus-cache'), 'miss');
  const b = await fetch(`${base(proxy)}/feed/slow/x?q=1`);
  assert.equal(b.headers.get('x-argus-cache'), 'hit');
  assert.deepEqual(await b.json(), await a.json());
  assert.equal(state.hits, 1);

  await fetch(`${base(proxy)}/feed/slow/x?q=2`); // different query, different entry
  assert.equal(state.hits, 2);

  await fetch(`${base(proxy)}/feed/live/x`);
  const live = await fetch(`${base(proxy)}/feed/live/x`);
  assert.equal(live.headers.get('x-argus-cache'), null);
  assert.equal(state.hits, 4);
});

test('a cached feed serves its last good body when the upstream fails', async (t) => {
  const { server, state } = await startCounter();
  t.after(() => server.close());
  const feeds = [
    { id: 'f', baseUrl: base(server), cache: { ttlMs: 0, staleMs: 60_000 } },
  ];
  const proxy = await startProxy(feeds);
  t.after(() => proxy.close());

  const good = await (await fetch(`${base(proxy)}/feed/f/x`)).json();
  state.status = 503;
  const r = await fetch(`${base(proxy)}/feed/f/x`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-argus-cache'), 'stale');
  assert.deepEqual(await r.json(), good);

  state.status = 404; // a client error is passed through, not masked
  assert.equal((await fetch(`${base(proxy)}/feed/f/x`)).status, 404);
});

test('baseUrlEnv points a feed at another instance, keeping the path allowlist', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [
    {
      id: 'ovp',
      baseUrl: 'https://unreachable.invalid/api',
      baseUrlEnv: 'TEST_OVP_URL',
      allowPaths: [/^\/api\/interpreter$/],
    },
  ];
  process.env.TEST_OVP_URL = `${base(echo)}/mirror/api`;
  const proxy = await startProxy(feeds);
  t.after(() => {
    proxy.close();
    delete process.env.TEST_OVP_URL;
  });

  const r = await fetch(`${base(proxy)}/feed/ovp/interpreter?data=x`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, '/mirror/api/interpreter?data=x');
  assert.equal((await fetch(`${base(proxy)}/feed/ovp/status`)).status, 403);
  // A longer path that merely ends the same way is refused.
  assert.equal(
    (await fetch(`${base(proxy)}/feed/ovp/kill_my_queries/api/interpreter`)).status,
    403,
  );
});

test('a localOnly feed needs its URL, and only reaches this machine or the LAN', async (t) => {
  const echo = await startEcho();
  t.after(() => echo.close());
  const feeds = [
    {
      id: 'rx',
      baseUrl: 'http://localhost:1/data',
      baseUrlEnv: 'TEST_RX_URL',
      localOnly: true,
      allowPaths: [/^\/data\/aircraft\.json$/],
    },
  ];
  const proxy = await startProxy(feeds);
  t.after(() => {
    proxy.close();
    delete process.env.TEST_RX_URL;
  });
  const get = (p) => fetch(`${base(proxy)}/feed/rx${p}`);

  let r = await get('/aircraft.json');
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /set TEST_RX_URL/);

  process.env.TEST_RX_URL = 'https://example.com/data';
  r = await get('/aircraft.json');
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /this machine or the LAN/);

  process.env.TEST_RX_URL = `${base(echo)}/data`;
  r = await get('/aircraft.json');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, '/data/aircraft.json');
  assert.equal((await get('/stats.json')).status, 403);
});

test('isLocalHost accepts loopback, private and .local names only', async () => {
  const { isLocalHost } = await import('../lib/relay.js');
  for (const h of [
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.5',
    '192.168.1.40',
    'piaware.local',
    '[::1]',
    'fd12:3456::1',
  ])
    assert.equal(isLocalHost(h), true, h);
  for (const h of [
    'example.com',
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    '169.254.169.254',
    'local.example.com',
  ])
    assert.equal(isLocalHost(h), false, h);
});

test('the cache key includes Accept, so one client cannot change what others get', async (t) => {
  const server = await listen((req, res) => {
    const html = /html/.test(req.headers.accept || '');
    res.writeHead(200, { 'content-type': html ? 'text/html' : 'application/json' });
    res.end(html ? '<html></html>' : '{"ok":true}');
  });
  t.after(() => server.close());
  const proxy = await startProxy([
    { id: 'api', baseUrl: base(server), cache: { ttlMs: 60_000 } },
  ]);
  t.after(() => proxy.close());
  await fetch(`${base(proxy)}/feed/api/x`, { headers: { accept: 'text/html' } });
  const r = await fetch(`${base(proxy)}/feed/api/x`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(r.headers.get('content-type'), 'application/json');
  assert.deepEqual(await r.json(), { ok: true });
});

test('concurrent requests cannot exceed a governed budget', async (t) => {
  const { server, state } = await startCounter();
  t.after(() => server.close());
  const feeds = [
    { id: 'metered', baseUrl: base(server), governor: { ratePerMinute: 3 } },
  ];
  const config = loadConfig({});
  const { createGovernor } = await import('../lib/governor.js');
  const proxy = await listen(
    createRequestHandler({ config, feeds, governor: createGovernor(feeds) }),
  );
  t.after(() => proxy.close());
  const codes = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      fetch(`${base(proxy)}/feed/metered/x?i=${i}`).then((r) => r.status),
    ),
  );
  assert.equal(codes.filter((c) => c === 200).length, 3);
  assert.equal(state.hits, 3);
});

test('a localOnly feed never follows a redirect off the device', async (t) => {
  const outside = await startEcho();
  t.after(() => outside.close());
  const device = await listen((req, res) => {
    res.writeHead(302, { location: `${base(outside)}/elsewhere` });
    res.end();
  });
  t.after(() => device.close());
  process.env.TEST_RX2_URL = `${base(device)}/data`;
  const proxy = await startProxy([
    {
      id: 'rx2',
      baseUrl: 'http://localhost:1/data',
      baseUrlEnv: 'TEST_RX2_URL',
      localOnly: true,
      allowPaths: [/^\/data\/aircraft\.json$/],
    },
  ]);
  t.after(() => {
    proxy.close();
    delete process.env.TEST_RX2_URL;
  });
  assert.equal((await fetch(`${base(proxy)}/feed/rx2/aircraft.json`)).status, 502);
});

test('relayed bodies carry nosniff and a sandbox CSP', async (t) => {
  const up = await startEcho();
  t.after(() => up.close());
  const proxy = await startProxy([{ id: 'echo', baseUrl: `${base(up)}/api` }]);
  t.after(() => proxy.close());
  const res = await fetch(`${base(proxy)}/feed/echo/x`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

test('an image-only feed refuses a body that is not an image', async (t) => {
  let type = 'text/html';
  const up = await listen((req, res) => {
    res.writeHead(200, { 'content-type': type });
    res.end(
      type === 'image/jpeg' ? Buffer.from([0xff, 0xd8, 0xff]) : '<script>1</script>',
    );
  });
  t.after(() => up.close());
  const proxy = await startProxy([
    { id: 'cam-img', baseUrl: `${base(up)}/img`, imageOnly: true },
  ]);
  t.after(() => proxy.close());
  assert.equal((await fetch(`${base(proxy)}/feed/cam-img/a.jpg`)).status, 502);
  type = 'image/jpeg';
  const ok = await fetch(`${base(proxy)}/feed/cam-img/a.jpg`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
});

test('redirects are followed on the same host, a bounded number of times', async (t) => {
  const up = await listen((req, res) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n') || 0);
    if (req.url.startsWith('/api/final')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else if (req.url.startsWith('/api/loop')) {
      res.writeHead(302, { location: `/api/loop?n=${n + 1}` });
      res.end();
    } else {
      res.writeHead(301, { location: '/api/final' });
      res.end();
    }
  });
  t.after(() => up.close());
  const proxy = await startProxy([{ id: 'r', baseUrl: `${base(up)}/api` }]);
  t.after(() => proxy.close());
  const res = await fetch(`${base(proxy)}/feed/r/start`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal((await fetch(`${base(proxy)}/feed/r/loop`)).status, 502);
});

test('private hosts: loopback, LAN, link-local', () => {
  for (const h of [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.9',
    '169.254.169.254',
    '0.0.0.0',
    '[::1]',
    'fe80::1',
    'printer.local',
  ])
    assert.equal(isPrivateHost(h), true, h);
  for (const h of ['example.org', '8.8.8.8', '172.32.0.1'])
    assert.equal(isPrivateHost(h), false, h);
});
