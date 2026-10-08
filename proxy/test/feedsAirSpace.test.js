import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validateFeeds } from '../lib/config.js';
import { buildUpstreamUrl, resolveBaseUrl } from '../lib/relay.js';
import { createRequestHandler } from '../lib/app.js';
import { loadConfig } from '../lib/config.js';
import { feeds } from '../feeds.js';

const feed = (id) => feeds.find((f) => f.id === id);
const allowed = (id, p) => feed(id).allowPaths.some((re) => re.test(p));
const query = (id, s) =>
  feed(id).allowQuery ? feed(id).allowQuery(new URLSearchParams(s)) : true;

test('the air and space feeds are registered and validate', () => {
  assert.equal(validateFeeds(feeds), feeds);
  for (const id of ['local-uat', 'adsblol-trace', 'adsbdb']) assert.ok(feed(id), id);
  // Keyless: nothing is injected, so no secret is involved anywhere.
  for (const id of ['local-uat', 'adsblol-trace', 'adsbdb']) {
    assert.equal(feed(id).inject, undefined, `${id} is keyless`);
  }
});

test('local-uat is your own equipment: LAN only, one file', () => {
  const f = feed('local-uat');
  assert.equal(f.localOnly, true);
  assert.equal(f.baseUrlEnv, 'LOCAL_UAT_URL');
  assert.equal(resolveBaseUrl(f, {}).ok, false); // not configured until set
  assert.equal(
    resolveBaseUrl(f, { LOCAL_UAT_URL: 'http://192.168.1.20:8978/data' }).ok,
    true,
  );
  assert.equal(
    resolveBaseUrl(f, { LOCAL_UAT_URL: 'https://example.com/data' }).ok,
    false,
  );
  assert.ok(allowed('local-uat', '/data/aircraft.json'));
  assert.equal(allowed('local-uat', '/data/receiver.json'), false);
  assert.equal(allowed('local-uat', '/data/aircraft.json/x'), false);
});

test('local-uat relays to the receiver named by LOCAL_UAT_URL, one file only', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, now: 1, aircraft: [] }));
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = http.createServer(
    createRequestHandler({ config: loadConfig({}), feeds }),
  );
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const saved = process.env.LOCAL_UAT_URL;
  t.after(() => {
    upstream.close();
    proxy.close();
    if (saved === undefined) delete process.env.LOCAL_UAT_URL;
    else process.env.LOCAL_UAT_URL = saved;
  });
  const get = (p) => fetch(`http://127.0.0.1:${proxy.address().port}/feed/local-uat${p}`);

  delete process.env.LOCAL_UAT_URL;
  let r = await get('/aircraft.json');
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /set LOCAL_UAT_URL/);

  // A skyaware978 instance under a prefix: the allowlist is judged on /data.
  process.env.LOCAL_UAT_URL = `http://127.0.0.1:${upstream.address().port}/skyaware978/data`;
  r = await get('/aircraft.json');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).url, '/skyaware978/data/aircraft.json');
  assert.equal((await get('/receiver.json')).status, 403);
});

test('adsblol-trace reaches only trace_full files in their own directory', () => {
  assert.ok(allowed('adsblol-trace', '/data/traces/23/trace_full_abc123.json'));
  assert.ok(allowed('adsblol-trace', '/data/traces/23/trace_full_~abc123.json'));
  // The directory must be the address's last two hex digits.
  assert.equal(allowed('adsblol-trace', '/data/traces/24/trace_full_abc123.json'), false);
  assert.equal(
    allowed('adsblol-trace', '/data/traces/23/trace_recent_abc123.json'),
    false,
  );
  assert.equal(allowed('adsblol-trace', '/data/traces/23/trace_full_ABC123.json'), false);
  assert.equal(
    allowed('adsblol-trace', '/data/traces/23/trace_full_abcd123.json'),
    false,
  );
  assert.equal(allowed('adsblol-trace', '/v2/mil'), false);
  assert.equal(allowed('adsblol-trace', '/data/aircraft.json'), false);
  assert.equal(query('adsblol-trace', ''), true);
  assert.equal(query('adsblol-trace', 'x=1'), false);
  // The tilde survives URL resolution, so the pinned path is what is fetched.
  const u = buildUpstreamUrl(
    feed('adsblol-trace'),
    '/data/traces/23/trace_full_~abc123.json',
    '',
  );
  assert.equal(u.href, 'https://adsb.lol/data/traces/23/trace_full_~abc123.json');
  assert.equal(feed('adsblol-trace').governor.ratePerMinute, 10);
  assert.equal(feed('adsblol-trace').cache.ttlMs, 60_000);
});

test('adsbdb reaches the aircraft and callsign lookups only', () => {
  assert.ok(allowed('adsbdb', '/v0/aircraft/a1b2c3'));
  assert.ok(allowed('adsbdb', '/v0/callsign/BAW123'));
  assert.equal(allowed('adsbdb', '/v0/aircraft/a1b2c3/x'), false);
  assert.equal(allowed('adsbdb', '/v0/aircraft/~a1b2c3'), false);
  assert.equal(allowed('adsbdb', '/v0/callsign/BAW 123'), false);
  assert.equal(allowed('adsbdb', '/v0/n-number/N12345'), false);
  assert.equal(allowed('adsbdb', '/v0/airline/BAW'), false);
  assert.equal(query('adsbdb', 'callsign=BAW123'), false);
  const f = feed('adsbdb');
  assert.equal(f.cache.ttlMs, 24 * 60 * 60_000);
  assert.ok(f.governor.ratePerMinute <= 300);
});

test('ll2 reaches the launch list and one launch by its id, nothing else', () => {
  assert.ok(allowed('ll2', '/2.3.0/launches/'));
  assert.ok(allowed('ll2', '/2.3.0/launches/f059f0e5-7b8e-4e5a-a0d7-8f1c3c5e2a10/'));
  assert.ok(allowed('ll2', '/2.3.0/launches/f059f0e5-7b8e-4e5a-a0d7-8f1c3c5e2a10'));
  assert.equal(allowed('ll2', '/2.3.0/launches/upcoming/'), false);
  assert.equal(allowed('ll2', '/2.3.0/launches/f059f0e5/'), false);
  assert.equal(allowed('ll2', '/2.3.0/agencies/'), false);
});
