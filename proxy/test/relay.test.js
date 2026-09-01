import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { buildUpstreamUrl, RelayError } from '../lib/relay.js';

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
