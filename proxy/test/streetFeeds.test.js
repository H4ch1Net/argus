import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  feeds,
  MAPILLARY_FIELDS,
  flowPointOk,
  mapillaryBboxOk,
  thumbQueryOk,
} from '../feeds/streets.js';
import { feeds as registry } from '../feeds.js';
import { validateFeeds } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import { createGovernor } from '../lib/governor.js';
import {
  flowQuery,
  flowSegmentPath,
  FLOW_ZOOMS,
} from '../../core/layers/simtraffic/flow.js';
import {
  MAPILLARY_FIELDS as CORE_FIELDS,
  mapillaryQuery,
  mapillaryThumbPath,
  mapillaryTiles,
  tileAt,
} from '../../core/layers/streetphotos/parse.js';

const feed = (id) => feeds.find((f) => f.id === id);

function admits(feedId, path, params) {
  const f = feed(feedId);
  const qs = new URLSearchParams(params ?? {}).toString();
  let target;
  try {
    target = buildUpstreamUrl(f, path, qs ? `?${qs}` : '');
  } catch {
    return false;
  }
  const pathOk = f.allowPaths.some((re) => re.test(target.pathname));
  return pathOk && (f.allowQuery ? f.allowQuery(target.searchParams) : true);
}

test('the street feeds validate, are registered, pinned, governed and cached', () => {
  assert.equal(validateFeeds(feeds), feeds);
  assert.deepEqual(
    feeds.map((f) => f.id),
    ['tomtom-flowseg', 'mapillary', 'mapillary-img'],
  );
  for (const f of feeds) {
    assert.ok(registry.includes(f), `${f.id} is spread into proxy/feeds.js`);
    assert.ok(f.allowPaths.length && f.allowQuery, `${f.id} pins path and query`);
    assert.match(f.headers['user-agent'], /^Argus\//);
    assert.ok(f.governor.ratePerMinute > 0);
    assert.ok(f.cache.ttlMs >= 60_000);
  }
  assert.deepEqual(feed('tomtom-flowseg').inject, [
    { secret: 'TOMTOM_API_KEY', as: 'query', name: 'key' },
  ]);
  // The Mapillary token goes in a header, never in a URL.
  assert.deepEqual(feed('mapillary').inject, [
    {
      secret: 'MAPILLARY_TOKEN',
      as: 'header',
      name: 'Authorization',
      template: 'OAuth {value}',
    },
  ]);
  assert.equal(feed('mapillary-img').imageOnly, true);
  assert.equal(feed('mapillary-img').inject, undefined);
});

test('TomTom flow segments: exactly what core builds', () => {
  for (const rank of [0, 2, 3, 4, 6]) {
    assert.ok(
      admits('tomtom-flowseg', flowSegmentPath(rank), flowQuery(37.7749, -122.4194)),
    );
  }
  for (const z of FLOW_ZOOMS) {
    assert.ok(
      admits('tomtom-flowseg', `/flowSegmentData/absolute/${z}/json`, { point: '1,2' }),
    );
  }
  const ok = flowQuery(51.5, -0.12);
  assert.equal(admits('tomtom-flowseg', '/flowSegmentData/absolute/22/json', ok), false);
  assert.equal(admits('tomtom-flowseg', '/flowSegmentData/relative/14/json', ok), false);
  assert.equal(admits('tomtom-flowseg', '/flowSegmentData/absolute/14/xml', ok), false);
  assert.equal(admits('tomtom-flowseg', '/flowSegmentData/absolute/14/json', {}), false);
  // The client may never send a key, or anything else.
  assert.equal(
    admits('tomtom-flowseg', flowSegmentPath(3), { ...ok, key: 'mine' }),
    false,
  );
  assert.equal(
    admits('tomtom-flowseg', flowSegmentPath(3), { ...ok, unit: 'MPH' }),
    false,
  );
  assert.equal(flowPointOk('91.0,0'), false);
  assert.equal(flowPointOk('10.123456,0'), false);
  assert.equal(flowPointOk('-33.86785,151.20732'), true);
});

test('TomTom flow segments: the budget stays inside the free daily allowance', () => {
  const g = createGovernor(feeds, () => 0);
  const f = feed('tomtom-flowseg');
  assert.ok(f.governor.creditBudget + 2000 <= 2500, 'with incidents, under 2,500 a day');
  for (let i = 0; i < f.governor.ratePerMinute; i += 1)
    g.record('tomtom-flowseg', g.check('tomtom-flowseg', '/x').cost);
  assert.equal(g.check('tomtom-flowseg', '/x').ok, false);
});

test('Mapillary: exactly what core builds, small boxes only, no creator fields', () => {
  assert.equal(CORE_FIELDS, MAPILLARY_FIELDS, 'core and proxy agree on fields');
  assert.doesNotMatch(MAPILLARY_FIELDS, /creator|user|owner/);
  const view = { lamin: 37.77, lomin: -122.43, lamax: 37.79, lomax: -122.41 };
  const tiles = mapillaryTiles(view);
  assert.ok(tiles.length >= 4);
  for (const t of tiles) assert.ok(admits('mapillary', '/images', mapillaryQuery(t)));
  assert.ok(admits('mapillary', '/images', mapillaryQuery(tileAt(-33.86, 151.2))));
  const q = mapillaryQuery(tiles[0]);
  assert.equal(admits('mapillary', '/images', { ...q, limit: '2000' }), false);
  assert.equal(
    admits('mapillary', '/images', { ...q, fields: `${MAPILLARY_FIELDS},creator` }),
    false,
  );
  assert.equal(admits('mapillary', '/images', { ...q, access_token: 'MLY|x' }), false);
  assert.equal(
    admits('mapillary', '/images', { ...q, bbox: '-122.5,37.7,-122.3,37.9' }),
    false,
  );
  assert.equal(admits('mapillary', '/12345', q), false);
  assert.equal(admits('mapillary', '/images/extra', q), false);
  assert.equal(mapillaryBboxOk('1,2,1,3'), false); // empty in longitude
  assert.equal(mapillaryBboxOk('10,20,10.01,20.01'), true);
});

test('Mapillary thumbnails: only image paths on the CDN, rewritten by core', () => {
  // The documented shape of a thumb_1024_url (Meta's image CDN, signed).
  const url =
    'https://scontent-fra5-1.xx.fbcdn.net/m1/v/t6/An8rT4bU2vQx-_Yz0123456789abcdefABCDEF?stp=s1024x768&ccb=10-5&oh=00_AfB1c2d3e4f5&oe=6713A2F0&_nc_sid=201bca';
  const p = mapillaryThumbPath(url);
  assert.ok(p);
  assert.ok(admits('mapillary-img', p.path, p.params));
  assert.equal(mapillaryThumbPath('https://evil.example/m1/v/t6/abcdefghij'), null);
  assert.equal(
    mapillaryThumbPath('http://scontent.xx.fbcdn.net/m1/v/t6/abcdefghij'),
    null,
  );
  assert.equal(
    mapillaryThumbPath('https://scontent.xx.fbcdn.net/v/t39/abcdefghij'),
    null,
  );
  assert.equal(admits('mapillary-img', '/m1/v/t6/../../etc', {}), false);
  assert.equal(admits('mapillary-img', '/m1/v/t6/abcdefghij', { url: 'x' }), false);
  assert.equal(thumbQueryOk(new URLSearchParams('oh=a b')), false);
  assert.equal(thumbQueryOk(new URLSearchParams('stp=s256x256&_nc_ht=x')), true);
});
