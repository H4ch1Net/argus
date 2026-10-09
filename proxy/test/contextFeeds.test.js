import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { feeds, AQ_CURRENT, ONIONOO_FIELDS } from '../feeds/context.js';
import { gdeltTheme, mergeGdeltEvents, parseExportTsv } from '../lib/gdelt.js';
import { feeds as registry } from '../feeds.js';
import { validateFeeds } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import { AURORA_PATH, KP_PATH } from '../../core/layers/aurora/parse.js';
import {
  aqGrid,
  aqQuery,
  AQ_CURRENT as CORE_AQ,
  AQ_PATH,
} from '../../core/layers/airquality/field.js';
import {
  blackMarbleQuery,
  BLACK_MARBLE_PATH,
} from '../../core/layers/terminator/night.js';
import {
  onionooQuery,
  ONIONOO_FIELDS as CORE_ONIONOO,
  ONIONOO_PATH,
} from '../../core/layers/tor/parse.js';
import {
  GDELT_FEED,
  GDELT_THEMES,
  GDELT_EVENTS_PATH,
  parseGdeltEvents,
} from '../../core/layers/gdelt/parse.js';

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

test('the context feeds validate, are in the registry, keyless, pinned and cached', () => {
  assert.equal(validateFeeds(feeds), feeds);
  assert.deepEqual(
    feeds.map((f) => f.id),
    ['swpc', 'openmeteo-aq', 'gibs-night', 'onionoo', 'gdelt-events'],
  );
  const ids = new Set(registry.map((f) => f.id));
  assert.equal(ids.size, registry.length, 'no id clashes with the rest of the registry');
  for (const f of feeds) {
    assert.ok(registry.includes(f), `${f.id} is spread into proxy/feeds.js`);
    assert.equal(f.inject, undefined, `${f.id} is keyless`);
    assert.ok(f.allowPaths.length && f.allowQuery, `${f.id} pins path and query`);
    assert.match(f.headers['user-agent'], /^Argus\//);
    assert.ok(f.governor.ratePerMinute > 0);
    assert.ok(f.cache.ttlMs >= 5 * 60_000);
  }
  assert.equal(feed('gibs-night').imageOnly, true);
});

test('core and proxy agree on the pinned constants', () => {
  assert.equal(CORE_AQ, AQ_CURRENT);
  assert.equal(CORE_ONIONOO, ONIONOO_FIELDS);
  // Every theme the proxy assigns is one core knows.
  const core = new Set(GDELT_THEMES.map((t) => t.id));
  for (const code of ['073', '0233', '0333', '141', '145', '180', '190', '195', '204'])
    assert.ok(core.has(gdeltTheme(code)), code);
});

test("GDELT: the proxy's document from a real export is what core parses", () => {
  const csv = fs.readFileSync(
    new URL('./fixtures/gdelt-sample.export.CSV', import.meta.url),
    'utf8',
  );
  const events = mergeGdeltEvents(parseExportTsv(csv));
  const doc = JSON.parse(
    JSON.stringify({ v: 1, updated: '2026-10-09T06:00:00Z', windowMinutes: 15, events }),
  );
  const points = parseGdeltEvents(doc);
  assert.equal(points.length, events.length);
  assert.ok(points.every((n) => n.meta.codeLabel && !/^Event /.test(n.meta.codeLabel)));
  assert.ok(points.some((n) => n.meta.articles.length));
  assert.equal(GDELT_FEED, 'gdelt-events');
});

test('SWPC: the two files, nothing else', () => {
  assert.equal(admits('swpc', clientUrl('swpc', AURORA_PATH)), true);
  assert.equal(admits('swpc', clientUrl('swpc', KP_PATH)), true);
  assert.equal(admits('swpc', clientUrl('swpc', AURORA_PATH, { x: 1 })), false);
  assert.equal(admits('swpc', clientUrl('swpc', '/rtsw/rtsw_wind_1m.json')), false);
  assert.equal(admits('swpc', clientUrl('swpc', '/../products/alerts.json')), false);
});

test('air quality: the view grid query, nothing else', () => {
  for (const v of [
    { lamin: 40, lomin: -10, lamax: 55, lomax: 10 },
    { lamin: 33.9, lomin: -118.5, lamax: 34.2, lomax: -118.1 },
    { lamin: -10, lamax: 10, lomin: 170, lomax: -170, wrap: { west: 170, east: 190 } },
  ]) {
    const q = aqQuery(aqGrid(v));
    assert.equal(admits('openmeteo-aq', clientUrl('openmeteo-aq', AQ_PATH, q)), true);
  }
  const q = aqQuery(aqGrid({ lamin: 40, lomin: -10, lamax: 55, lomax: 10 }));
  const url = (p) => clientUrl('openmeteo-aq', AQ_PATH, { ...q, ...p });
  assert.equal(admits('openmeteo-aq', url({ hourly: 'pm10' })), false);
  assert.equal(admits('openmeteo-aq', url({ current: 'us_aqi' })), false);
  assert.equal(admits('openmeteo-aq', url({ longitude: '1,2' })), false);
  assert.equal(
    admits('openmeteo-aq', url({ latitude: q.latitude.replace(/^[^,]+/, '95') })),
    false,
  );
  assert.equal(admits('openmeteo-aq', clientUrl('openmeteo-aq', '/forecast', q)), false);
});

test('GIBS night lights: one global image, 1024 or 2048 wide', () => {
  for (const w of [1024, 2048]) {
    assert.equal(
      admits(
        'gibs-night',
        clientUrl('gibs-night', BLACK_MARBLE_PATH, blackMarbleQuery(w)),
      ),
      true,
    );
  }
  const q = blackMarbleQuery(1024);
  const url = (p) => clientUrl('gibs-night', BLACK_MARBLE_PATH, { ...q, ...p });
  assert.equal(admits('gibs-night', url({ HEIGHT: '1024' })), false, 'mismatched size');
  assert.equal(admits('gibs-night', url({ WIDTH: '8192', HEIGHT: '4096' })), false);
  assert.equal(
    admits('gibs-night', url({ LAYERS: 'MODIS_Terra_CorrectedReflectance_TrueColor' })),
    false,
  );
  assert.equal(admits('gibs-night', url({ REQUEST: 'GetCapabilities' })), false);
  assert.equal(admits('gibs-night', url({ BBOX: '0,0,10,10' })), false);
  assert.equal(admits('gibs-night', url({ TIME: '2016-01-01' })), false);
  assert.equal(admits('gibs-night', clientUrl('gibs-night', '/wmts.cgi', q)), false);
});

test('Onionoo: running relays, the public fields only', () => {
  assert.equal(
    admits('onionoo', clientUrl('onionoo', ONIONOO_PATH, onionooQuery())),
    true,
  );
  const url = (p) => clientUrl('onionoo', ONIONOO_PATH, { ...onionooQuery(), ...p });
  assert.equal(admits('onionoo', url({ fields: `${ONIONOO_FIELDS},contact` })), false);
  assert.equal(admits('onionoo', url({ search: 'nickname' })), false);
  assert.equal(admits('onionoo', url({ type: 'bridge' })), false);
  assert.equal(
    admits('onionoo', clientUrl('onionoo', '/summary', onionooQuery())),
    false,
  );
});

test('GDELT events: the one document, no query, never free text', () => {
  assert.equal(
    admits('gdelt-events', clientUrl('gdelt-events', GDELT_EVENTS_PATH)),
    true,
  );
  const url = (p) => clientUrl('gdelt-events', GDELT_EVENTS_PATH, p);
  assert.equal(admits('gdelt-events', url({ query: 'John Smith' })), false);
  assert.equal(admits('gdelt-events', url({ theme: 'PROTEST' })), false);
  assert.equal(
    admits('gdelt-events', clientUrl('gdelt-events', '/lastupdate.txt')),
    false,
    'the upstream files are fetched by the proxy, never asked for by the client',
  );
  assert.equal(
    admits('gdelt-events', clientUrl('gdelt-events', '/20261009060000.export.CSV.zip')),
    false,
  );
  assert.equal(
    admits('gdelt-events', clientUrl('gdelt-events', '/../x/events.json')),
    false,
  );
});
