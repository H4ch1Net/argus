import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFeeds } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import { WFIGS_OUT_FIELDS } from '../feeds/earth.js';

const q = (s) => new URLSearchParams(s);
const { feeds } = await import('../feeds.js');
const feed = (id) => feeds.find((f) => f.id === id);
// The relay's own check (escaping the base path throws) plus the allowlist.
const pathOk = (f, sub, search = '') => {
  let target;
  try {
    target = buildUpstreamUrl(f, sub, search);
  } catch {
    return false;
  }
  return f.allowPaths.some((re) => re.test(target.pathname));
};

test('the Earth feeds validate, are keyless, cached and identify the app', () => {
  assert.equal(validateFeeds(feeds), feeds);
  for (const id of ['nhc-gis', 'wfigs']) {
    const f = feed(id);
    assert.ok(f, `${id} is registered`);
    assert.equal(f.inject, undefined);
    assert.match(f.headers['user-agent'], /^Argus\//);
    assert.ok(f.cache.ttlMs >= 60_000);
    assert.ok(f.governor.ratePerMinute > 0);
  }
});

test('nhc-gis reaches only the three forecast layers, with a pinned query', () => {
  const f = feed('nhc-gis');
  for (const n of [5, 6, 7]) assert.ok(pathOk(f, `/${n}/query`));
  assert.equal(pathOk(f, '/4/query'), false);
  assert.equal(pathOk(f, '/7'), false);
  assert.equal(pathOk(f, '/../../../../x/MapServer/7/query'), false);
  assert.equal(pathOk(f, '/../MapServer/7/query'), true); // resolves back inside
  const ok =
    'where=1%3D1&outFields=idp_source%2Cadvisnum%2Ctau%2Cmaxwind%2Cgust&outSR=4326&resultRecordCount=500&geometryPrecision=4&f=geojson';
  assert.equal(f.allowQuery(q(ok)), true);
  assert.equal(
    f.allowQuery(q('where=1%3D1&outFields=idp_source%2Cadvisnum&outSR=4326&f=geojson')),
    true,
  );
  assert.equal(f.allowQuery(q(ok.replace('f=geojson', 'f=html'))), false);
  assert.equal(f.allowQuery(q(ok.replace('where=1%3D1', 'where=1%3D1+OR+x'))), false);
  assert.equal(f.allowQuery(q(ok.replace('outFields=idp_source', 'outFields=*'))), false);
  assert.equal(
    f.allowQuery(q(ok.replace('resultRecordCount=500', 'resultRecordCount=5000'))),
    false,
  );
  assert.equal(f.allowQuery(q(`${ok}&returnIdsOnly=true`)), false);
  assert.equal(f.allowQuery(q(`${ok}&f=json`)), false); // repeated key
  assert.equal(f.allowQuery(q('outSR=4326&f=geojson')), false); // missing keys
});

test('wfigs reaches only the current perimeters query, pinned to the reference fields', async () => {
  const f = feed('wfigs');
  assert.ok(pathOk(f, '/0/query'));
  assert.equal(pathOk(f, '/1/query'), false);
  assert.equal(pathOk(f, '/0/query/extra'), false);
  assert.equal(pathOk(f, '/0/applyEdits'), false);
  const { wfigsParams } = await import('../../core/layers/perimeters/parse.js');
  // The client asks exactly what the proxy allows.
  assert.equal(wfigsParams().outFields, WFIGS_OUT_FIELDS);
  assert.equal(f.allowQuery(q(new URLSearchParams(wfigsParams()).toString())), true);
  assert.equal(f.allowQuery(q(new URLSearchParams(wfigsParams(4000)).toString())), true);
  assert.equal(
    f.allowQuery(q(new URLSearchParams(wfigsParams(50_000)).toString())),
    false,
  );
  const p = { ...wfigsParams(), outFields: '*' };
  assert.equal(f.allowQuery(q(new URLSearchParams(p).toString())), false);
  const fmt = { ...wfigsParams(), f: 'pbf' };
  assert.equal(f.allowQuery(q(new URLSearchParams(fmt).toString())), false);
});

test('the NHC GIS client parameters pass the proxy pin', async () => {
  const { NHC_GIS_LAYERS, nhcGisParams } =
    await import('../../core/layers/cyclones/forecast.js');
  const f = feed('nhc-gis');
  for (const layer of NHC_GIS_LAYERS) {
    assert.equal(
      f.allowQuery(q(new URLSearchParams(nhcGisParams(layer)).toString())),
      true,
    );
  }
});

test('nowcoast allows WMS 1.3.0 GetCapabilities and GetMap at one exact instant', async () => {
  const f = feed('nowcoast');
  const caps = 'service=WMS&version=1.3.0&request=GetCapabilities';
  assert.equal(f.allowQuery(q(caps)), true);
  assert.equal(f.allowQuery(q(caps.replace('1.3.0', '1.1.1'))), false);
  assert.equal(f.allowQuery(q(`${caps}&layers=x`)), false);
  assert.equal(f.allowQuery(q(caps.replace('WMS', 'WFS'))), false);
  const tile =
    'service=WMS&version=1.1.1&request=GetMap&layers=goes_longwave_imagery&styles=goes-lir&srs=EPSG:4326&bbox=0,0,1,1&width=256&height=256&format=image/png&transparent=true';
  assert.equal(f.allowQuery(q(tile)), true);
  assert.equal(f.allowQuery(q(`${tile}&time=2026-10-08T12:00:00.000Z`)), true);
  assert.equal(f.allowQuery(q(`${tile}&time=2026-10-08T12:00:00Z`)), true);
  for (const bad of [
    '2026-10-08T11:00:00Z/2026-10-08T12:00:00Z',
    '2026-10-08T11:00:00Z/PT1H',
    'current',
    '2026-10-08',
    '2026-10-08T12:00:00+01:00',
  ]) {
    assert.equal(f.allowQuery(q(`${tile}&time=${encodeURIComponent(bad)}`)), false, bad);
  }
  // The client's capabilities request is exactly what the proxy allows.
  const { CAPABILITIES_PARAMS } =
    await import('../../core/layers/weather/capabilities.js');
  assert.equal(
    f.allowQuery(q(new URLSearchParams(CAPABILITIES_PARAMS).toString())),
    true,
  );
  assert.equal(f.cache.ttlMs, 2 * 60_000);
});
