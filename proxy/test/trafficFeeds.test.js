import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { feeds, TOMTOM_INCIDENT_FIELDS, incidentBboxOk } from '../feeds/traffic.js';
import { feeds as registry } from '../feeds.js';
import { validateFeeds, loadConfig } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import { createRequestHandler } from '../lib/app.js';
import { createGovernor } from '../lib/governor.js';
import {
  incidentQuery,
  TOMTOM_INCIDENT_FIELDS as CORE_FIELDS,
  TOMTOM_INCIDENT_PATH,
} from '../../core/layers/incidents/parse.js';
import {
  wazeQuery,
  wazeLocalQuery,
  WAZE_PATH,
  WAZE_LOCAL_PATH,
} from '../../core/layers/waze/parse.js';

const feed = (id) => feeds.find((f) => f.id === id);

function clientUrl(feedId, path, params) {
  const url = new URL(`https://proxy.test/feed/${feedId}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  return url.toString();
}
function admits(feedId, href) {
  const f = feed(feedId);
  const u = new URL(href);
  const sub = u.pathname.slice(`/feed/${feedId}`.length);
  let target;
  try {
    target = buildUpstreamUrl(f, sub, u.search);
  } catch {
    return false;
  }
  const pathOk = f.allowPaths.some((re) => re.test(target.pathname));
  const queryOk = f.allowQuery ? f.allowQuery(target.searchParams) : true;
  return pathOk && queryOk;
}

test('the traffic feeds validate, are in the registry, pinned, governed and name the app', () => {
  assert.equal(validateFeeds(feeds), feeds);
  assert.deepEqual(
    feeds.map((f) => f.id),
    ['tomtom-incidents', 'chp-cad', 'waze', 'waze-local'],
  );
  for (const f of feeds) {
    assert.ok(registry.includes(f), `${f.id} is spread into proxy/feeds.js`);
    assert.ok(f.allowPaths.length && f.allowQuery, `${f.id} pins path and query`);
    assert.match(f.headers['user-agent'], /^Argus\//);
    assert.ok(f.governor.ratePerMinute > 0);
    assert.ok(f.cache.ttlMs >= 60_000);
  }
  assert.deepEqual(feed('tomtom-incidents').inject, [
    { secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' },
  ]);
  assert.equal(feed('chp-cad').inject, undefined, 'keyless');
});

test('TomTom incidents: exactly what core builds, nothing else', () => {
  assert.equal(CORE_FIELDS, TOMTOM_INCIDENT_FIELDS, 'core and proxy agree on fields');
  const views = [
    { lomin: -0.2, lamin: 51.45, lomax: 0.05, lamax: 51.56 },
    { lomin: -5, lamin: 48, lomax: 5, lamax: 54 },
    { lomin: 170, lamin: -20, lomax: -170, lamax: 0 },
    { lomin: 10, lamin: 69, lomax: 30, lamax: 71 },
  ];
  for (const v of views) {
    const url = clientUrl('tomtom-incidents', TOMTOM_INCIDENT_PATH, incidentQuery(v));
    assert.equal(admits('tomtom-incidents', url), true, JSON.stringify(v));
  }
  const ok = incidentQuery(views[0]);
  const url = (p) => clientUrl('tomtom-incidents', TOMTOM_INCIDENT_PATH, { ...ok, ...p });
  assert.equal(admits('tomtom-incidents', url({ key: 'stolen' })), false);
  assert.equal(admits('tomtom-incidents', url({ fields: '{incidents{type}}' })), false);
  assert.equal(admits('tomtom-incidents', url({ language: 'de-DE' })), false);
  assert.equal(admits('tomtom-incidents', url({ categoryFilter: '1' })), false);
  assert.equal(admits('tomtom-incidents', url({ bbox: '-5,48,5,54' })), false, 'too big');
  assert.equal(
    admits('tomtom-incidents', clientUrl('tomtom-incidents', '/incidentViewport', ok)),
    false,
  );
  assert.equal(
    admits(
      'tomtom-incidents',
      clientUrl('tomtom-incidents', '/../../map/4/tile/flow/relative0/1/1/1.png', ok),
    ),
    false,
  );
  assert.equal(incidentBboxOk('0,0,0.5,0.5'), true);
  assert.equal(incidentBboxOk('0.5,0,0,0.5'), false, 'inverted');
  assert.equal(incidentBboxOk('0,0,0.5'), false);
  assert.equal(incidentBboxOk('0,0,0.5,0.1234567'), false, 'precision');
  assert.equal(incidentBboxOk('-181,0,0,1'), false);
});

test('CHP: the one statewide file, no query', () => {
  assert.equal(admits('chp-cad', clientUrl('chp-cad', '/sa.xml')), true);
  assert.equal(admits('chp-cad', clientUrl('chp-cad', '/sa.xml', { x: 1 })), false);
  assert.equal(admits('chp-cad', clientUrl('chp-cad', '/other.xml')), false);
  assert.equal(admits('chp-cad', clientUrl('chp-cad', '/../index.html')), false);
  assert.equal(feed('chp-cad').baseUrlEnv, 'CHP_CAD_URL');
});

test('Waze: alerts and jams for a bounded box, never users, any region pin', () => {
  const views = [
    { lomin: -122.5, lamin: 37.7, lomax: -122.35, lamax: 37.82 },
    { lomin: -124, lamin: 36, lomax: -120, lamax: 39 }, // clipped to a degree
    { lomin: 2.2, lamin: 48.8, lomax: 2.45, lamax: 48.92 },
    { lomin: 34.7, lamin: 31.9, lomax: 34.9, lamax: 32.1 },
  ];
  for (const v of views) {
    assert.equal(admits('waze', clientUrl('waze', WAZE_PATH, wazeQuery(v))), true);
    assert.equal(
      admits('waze-local', clientUrl('waze-local', WAZE_LOCAL_PATH, wazeLocalQuery(v))),
      true,
    );
  }
  assert.deepEqual(
    [views[0], views[2], views[3]].map((v) => wazeQuery(v).env),
    ['na', 'row', 'il'],
  );
  const ok = wazeQuery(views[0]);
  const url = (p) => clientUrl('waze', WAZE_PATH, { ...ok, ...p });
  assert.equal(admits('waze', url({ types: 'alerts,traffic,users' })), false, 'no users');
  assert.equal(admits('waze', url({ types: 'users' })), false);
  assert.equal(admits('waze', url({ env: 'xx' })), false);
  assert.equal(admits('waze', url({ top: '39.50' })), false, 'too tall');
  assert.equal(admits('waze', url({ left: '-123.90' })), false, 'too wide');
  assert.equal(admits('waze', url({ top: '37.7' })), false, 'precision');
  assert.equal(admits('waze', url({ bottom: '37.90' })), false, 'inverted');
  assert.equal(admits('waze', url({ ma: '500' })), false, 'extra key');
  assert.equal(admits('waze', clientUrl('waze', '/live-map/api/user', ok)), false);
  assert.equal(admits('waze', clientUrl('waze', '/row-rtserver/web/TGeoRSS', ok)), false);
  assert.equal(feed('waze').baseUrlEnv, undefined, 'the live map only');
  assert.equal(feed('waze-local').localOnly, true);
  assert.equal(feed('waze-local').baseUrlEnv, 'LOCAL_WAZE_URL');
});

test('TomTom incidents: a daily request budget under the free allowance', () => {
  let t = 0;
  const gov = createGovernor([feed('tomtom-incidents')], () => t);
  let granted = 0;
  for (let i = 0; i < 2100; i += 1) {
    t += 4000; // one every 4 s stays under the per-minute rate
    if (gov.acquire('tomtom-incidents', '/x').ok) granted += 1;
  }
  assert.equal(granted, 2000);
  t += 24 * 3600_000 + 1;
  assert.equal(gov.acquire('tomtom-incidents', '/x').ok, true);
});

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('TomTom incidents through the relay: key server side, cached, 502 without it', async (t) => {
  const seen = [];
  const upstream = await listen((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"incidents":[]}');
  });
  t.after(() => upstream.close());
  const local = {
    ...feed('tomtom-incidents'),
    baseUrl: `http://127.0.0.1:${upstream.address().port}/traffic/services/5`,
  };
  const proxy = await listen(
    createRequestHandler({
      config: loadConfig({}),
      feeds: [local],
      governor: createGovernor([local]),
    }),
  );
  t.after(() => proxy.close());
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const q = new URLSearchParams(
    incidentQuery({ lomin: -0.2, lamin: 51.45, lomax: 0.05, lamax: 51.56 }),
  );
  const path = `/feed/tomtom-incidents/incidentDetails?${q}`;

  const saved = process.env.TOMTOM_API_KEY;
  t.after(() => {
    if (saved === undefined) delete process.env.TOMTOM_API_KEY;
    else process.env.TOMTOM_API_KEY = saved;
  });
  delete process.env.TOMTOM_API_KEY;
  const none = await fetch(base + path);
  assert.equal(none.status, 502);
  assert.match((await none.json()).error, /missing TOMTOM_API_KEY/);
  assert.equal(seen.length, 0);

  process.env.TOMTOM_API_KEY = 'tt-secret';
  const a = await fetch(base + path);
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), { incidents: [] });
  assert.equal(seen.length, 1);
  const sent = new URL(seen[0], 'http://x');
  assert.equal(sent.pathname, '/traffic/services/5/incidentDetails');
  assert.equal(sent.searchParams.get('key'), 'tt-secret');
  assert.equal(sent.searchParams.get('fields'), TOMTOM_INCIDENT_FIELDS);
  const b = await fetch(base + path);
  assert.equal(b.headers.get('x-argus-cache'), 'hit');
  await b.arrayBuffer();
  assert.equal(seen.length, 1);
  const forged = await fetch(`${base}${path}&key=mine`);
  assert.equal(forged.status, 403);
  assert.equal(seen.length, 1);
});
