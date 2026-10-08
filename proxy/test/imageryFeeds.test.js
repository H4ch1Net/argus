import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { feeds } from '../feeds/imagery.js';
import { validateFeeds, loadConfig } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import { createRequestHandler } from '../lib/app.js';
import { createGovernor } from '../lib/governor.js';
import {
  cmrQuery,
  catalogWindow,
  gibsTileTemplate,
  wvsSnapshotParams,
} from '../../core/layers/imagery/catalog.js';
import {
  trafficFlowSpec,
  TRAFFIC_FLOW_STYLES,
} from '../../core/layers/trafficflow/spec.js';
import {
  openMeteoQuery,
  gnewsQuery,
  gdeltQuery,
  OPEN_METEO_CURRENT,
} from '../../core/cockpit/briefing.js';

const feed = (id) => feeds.find((f) => f.id === id);

// The proxy client's buildUrl, then what the relay does with it: resolve the
// upstream URL and judge it against the feed's path and query pins.
function clientUrl(feedId, path, params) {
  const url = new URL(`https://proxy.test/feed/${feedId}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  return url.toString();
}
function admits(feedId, href) {
  const f = feed(feedId);
  const u = new URL(href);
  const sub = u.pathname.slice(`/feed/${feedId}`.length);
  const target = buildUpstreamUrl(f, sub, u.search);
  const pathOk = f.allowPaths.some((re) => re.test(target.pathname));
  const queryOk = f.allowQuery ? f.allowQuery(target.searchParams) : true;
  return pathOk && queryOk;
}
// A tile template with its placeholders filled in.
const tile = (template, z, x, y) =>
  template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

test('the imagery feeds validate, are path-pinned and name the app', () => {
  assert.equal(validateFeeds(feeds), feeds);
  assert.deepEqual(
    feeds.map((f) => f.id),
    ['cmr', 'gibs', 'wvs', 'tomtom-flow', 'openmeteo', 'gdelt', 'gnews'],
  );
  for (const f of feeds) {
    assert.ok(f.allowPaths?.length, `${f.id} has a path allowlist`);
    assert.equal(typeof f.allowQuery, 'function', `${f.id} pins its query`);
    assert.match(f.headers['user-agent'], /^Argus\//);
    assert.deepEqual(f.methods, ['GET']);
  }
  // Only TomTom needs a key, and it is injected server side.
  const keyed = feeds.filter((f) => f.inject?.length).map((f) => f.id);
  assert.deepEqual(keyed, ['tomtom-flow']);
  assert.deepEqual(feed('tomtom-flow').inject, [
    { secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' },
  ]);
});

test('what the core builders produce passes the pins', () => {
  const box = { west: -122.6, south: 37.6, east: -122.3, north: 37.9 };
  const win = catalogWindow(Date.parse('2026-10-08T12:00:00Z'));
  for (const product of ['S30', 'L30']) {
    assert.ok(
      admits(
        'cmr',
        clientUrl('cmr', '/granules.umm_json', cmrQuery({ product, box, ...win })),
      ),
    );
  }
  for (const product of ['S30', 'L30', 'VIIRS']) {
    const t = gibsTileTemplate(clientUrl, product, '2026-10-05');
    assert.ok(admits('gibs', tile(t, 7, 20, 49)), product);
    assert.ok(
      admits(
        'wvs',
        clientUrl(
          'wvs',
          '/snapshot',
          wvsSnapshotParams({ product, day: '2026-10-05', box }),
        ),
      ),
    );
  }
  for (const style of TRAFFIC_FLOW_STYLES) {
    assert.ok(
      admits(
        'tomtom-flow',
        tile(trafficFlowSpec(clientUrl, { style }).url, 14, 2620, 6332),
      ),
    );
  }
  const at = { latitude: -33.8688, longitude: 151.2093 };
  assert.ok(admits('openmeteo', clientUrl('openmeteo', '/forecast', openMeteoQuery(at))));
  assert.ok(admits('gnews', clientUrl('gnews', '/search', gnewsQuery('San José'))));
  assert.ok(admits('gdelt', clientUrl('gdelt', '/doc', gdeltQuery('Sydney'))));
});

test('the pins refuse anything else', () => {
  const box = { west: -122.6, south: 37.6, east: -122.3, north: 37.9 };
  const cmr = cmrQuery({ product: 'S30', box, ...catalogWindow(0) });
  const cmrUrl = (p) => clientUrl('cmr', '/granules.umm_json', { ...cmr, ...p });
  assert.equal(admits('cmr', cmrUrl({ page_size: '5000' })), false);
  assert.equal(admits('cmr', cmrUrl({ collection_concept_id: 'C1-OTHER' })), false);
  assert.equal(admits('cmr', cmrUrl({ provider: 'X' })), false);
  assert.equal(admits('cmr', clientUrl('cmr', '/collections.json', cmr)), false);

  const t = gibsTileTemplate(clientUrl, 'S30', '2026-10-05');
  assert.equal(admits('gibs', tile(t, 13, 1, 1)), false); // past z12
  assert.equal(admits('gibs', `${tile(t, 3, 1, 1)}?x=1`), false);
  assert.equal(
    admits('gibs', tile(t, 3, 1, 1).replace('HLS_S30_Nadir', 'MODIS_Terra_Secret')),
    false,
  );
  assert.equal(
    admits('gibs', clientUrl('gibs', '/../../wmts/1.0.0/WMTSCapabilities.xml')),
    false,
  );

  const wvs = wvsSnapshotParams({ product: 'S30', day: '2026-10-05', box });
  const wvsUrl = (p) => clientUrl('wvs', '/snapshot', { ...wvs, ...p });
  assert.equal(admits('wvs', wvsUrl({ WIDTH: '4096' })), false);
  assert.equal(admits('wvs', wvsUrl({ LAYERS: 'Some_Other_Layer' })), false);
  assert.equal(admits('wvs', wvsUrl({ REQUEST: 'GetCapabilities' })), false);

  const flow = tile(trafficFlowSpec(clientUrl).url, 10, 1, 1);
  assert.equal(admits('tomtom-flow', `${flow}?key=stolen`), false); // never the client's key
  assert.equal(admits('tomtom-flow', `${flow}?thickness=4&tileSize=512`), true);
  assert.equal(admits('tomtom-flow', `${flow}?tileSize=1024`), false);
  assert.equal(admits('tomtom-flow', flow.replace('/relative0/', '/x/')), false);
  assert.equal(admits('tomtom-flow', flow.replace('/10/', '/23/')), false);
  assert.equal(admits('tomtom-flow', flow.replace('.png', '.pbf')), false);

  const om = openMeteoQuery({ latitude: 1, longitude: 2 });
  const omUrl = (p) => clientUrl('openmeteo', '/forecast', { ...om, ...p });
  assert.equal(admits('openmeteo', omUrl({ latitude: '37.774929' })), false); // not rounded
  assert.equal(admits('openmeteo', omUrl({ latitude: '91' })), false);
  assert.equal(
    admits('openmeteo', omUrl({ current: `${OPEN_METEO_CURRENT},snowfall` })),
    false,
  );
  assert.equal(admits('openmeteo', omUrl({ hourly: 'temperature_2m' })), false);

  const gn = (p) => clientUrl('gnews', '/search', { ...gnewsQuery('Oakland'), ...p });
  assert.equal(admits('gnews', gn({ hl: 'de' })), false);
  assert.equal(admits('gnews', gn({ q: 'x'.repeat(101) })), false);
  assert.equal(admits('gnews', gn({ q: 'a"b' })), false);
  assert.equal(
    admits('gnews', clientUrl('gnews', '/topics/abc', gnewsQuery('Oakland'))),
    false,
  );

  const gd = (p) => clientUrl('gdelt', '/doc', { ...gdeltQuery('Oakland'), ...p });
  assert.equal(admits('gdelt', gd({ mode: 'timelinevol' })), false);
  assert.equal(admits('gdelt', gd({ query: 'Oakland' })), false); // must be a quoted phrase
  assert.equal(admits('gdelt', gd({ maxrecords: '250' })), false);
  assert.equal(admits('gdelt', gd({ timespan: '3months' })), false);
});

test('TomTom: a daily tile budget, refused once spent', () => {
  let t = 0;
  const gov = createGovernor([feed('tomtom-flow')], () => t);
  let granted = 0;
  for (let i = 0; i < 6001; i += 1) {
    t += 1000; // one tile a second stays under the per-minute rate
    if (gov.acquire('tomtom-flow', '/x').ok) granted += 1;
  }
  assert.equal(granted, 6000);
  t += 24 * 3600_000 + 1;
  assert.equal(gov.acquire('tomtom-flow', '/x').ok, true); // a new day
});

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('TomTom through the relay: key injected server side, tiles cached, 502 without a key', async (t) => {
  const seen = [];
  const upstream = await listen((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  t.after(() => upstream.close());
  const port = upstream.address().port;
  const local = {
    ...feed('tomtom-flow'),
    baseUrl: `http://127.0.0.1:${port}/traffic/map/4/tile/flow`,
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
  const tilePath = '/feed/tomtom-flow/relative0/12/655/1583.png';

  const saved = process.env.TOMTOM_API_KEY;
  t.after(() => {
    if (saved === undefined) delete process.env.TOMTOM_API_KEY;
    else process.env.TOMTOM_API_KEY = saved;
  });

  delete process.env.TOMTOM_API_KEY;
  const none = await fetch(base + tilePath);
  assert.equal(none.status, 502);
  assert.match((await none.json()).error, /missing TOMTOM_API_KEY/);
  assert.equal(seen.length, 0);

  process.env.TOMTOM_API_KEY = 'tt-secret';
  const a = await fetch(base + tilePath);
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('content-type'), 'image/png');
  assert.equal(a.headers.get('x-argus-cache'), 'miss');
  await a.arrayBuffer();
  assert.deepEqual(seen, [
    '/traffic/map/4/tile/flow/relative0/12/655/1583.png?key=tt-secret',
  ]);
  // The second view of the same tile is a cache hit: no upstream call, no budget.
  const b = await fetch(base + tilePath);
  assert.equal(b.headers.get('x-argus-cache'), 'hit');
  await b.arrayBuffer();
  assert.equal(seen.length, 1);
  // A client-supplied key is refused before anything is sent upstream.
  const forged = await fetch(`${base}${tilePath}?key=mine`);
  assert.equal(forged.status, 403);
  assert.equal(seen.length, 1);
});
