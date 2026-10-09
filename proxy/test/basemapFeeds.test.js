import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeds } from '../feeds/basemap.js';
import { feeds as registry } from '../feeds.js';
import { validateFeeds } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import {
  tileTemplate,
  BASEMAP_FEED,
  BASEMAP_TILES_FEED,
} from '../../core/scene/vector/client.js';

const feed = (id) => feeds.find((f) => f.id === id);

function admits(feedId, sub, search = '') {
  const f = feed(feedId);
  let target;
  try {
    target = buildUpstreamUrl(f, sub, search);
  } catch {
    return false;
  }
  return (
    f.allowPaths.some((re) => re.test(target.pathname)) &&
    (f.allowQuery ? f.allowQuery(target.searchParams) : true)
  );
}

test('the basemap feeds validate, are registered, pinned, cached and keyless', () => {
  assert.equal(validateFeeds(feeds), feeds);
  assert.deepEqual(
    feeds.map((f) => f.id),
    [BASEMAP_FEED, BASEMAP_TILES_FEED],
  );
  for (const f of feeds) {
    assert.ok(registry.includes(f), `${f.id} is spread into proxy/feeds.js`);
    assert.equal(f.inject, undefined, 'keyless');
    assert.match(f.headers['user-agent'], /^Argus\//);
    assert.ok(f.cache.ttlMs >= 6 * 3600_000);
  }
  assert.ok(feed(BASEMAP_TILES_FEED).cache.maxBytes <= 64e6, 'a phone-sized tile cache');
});

test('only the TileJSON and dated zoom 0 to 14 tiles, nothing else', () => {
  assert.equal(admits(BASEMAP_FEED, '/planet'), true);
  assert.equal(admits(BASEMAP_FEED, '/planet', '?x=1'), false);
  assert.equal(admits(BASEMAP_FEED, '/styles/liberty'), false);
  const tile = (z, x = 2902, y = 6560, ver = '20261004_113936_pt') =>
    `/planet/${ver}/${z}/${x}/${y}.pbf`;
  for (const z of [0, 5, 9, 10, 14])
    assert.equal(admits(BASEMAP_TILES_FEED, tile(z)), true);
  assert.equal(admits(BASEMAP_TILES_FEED, tile(15)), false, 'the source stops at 14');
  assert.equal(admits(BASEMAP_TILES_FEED, tile(14, 1, 1, 'latest')), false);
  assert.equal(admits(BASEMAP_TILES_FEED, tile(14), '?key=1'), false);
  assert.equal(admits(BASEMAP_TILES_FEED, '/planet'), false);
  assert.equal(admits(BASEMAP_TILES_FEED, `${tile(14)}/../../etc`), false);
});

test("core's tile template passes the pin", () => {
  const client = {
    buildUrl: (f, p) => `http://127.0.0.1:8787/feed/${f}${p}`,
  };
  const tpl = tileTemplate(client, {
    tiles: ['https://tiles.openfreemap.org/planet/20261004_113936_pt/{z}/{x}/{y}.pbf'],
  });
  const u = new URL(
    tpl.replace('{z}', '14').replace('{x}', '2902').replace('{y}', '6560'),
  );
  const sub = u.pathname.slice(`/feed/${BASEMAP_TILES_FEED}`.length);
  assert.equal(admits(BASEMAP_TILES_FEED, sub), true);
});
