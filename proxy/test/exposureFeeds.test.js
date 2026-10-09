import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  feeds,
  SHODAN_QUERIES,
  SHODAN_FACETS,
  shodanQueryOk,
  shodanQueryTextOk,
} from '../feeds/exposure.js';
import { feeds as registry } from '../feeds.js';
import { validateFeeds } from '../lib/config.js';
import { buildUpstreamUrl } from '../lib/relay.js';
import { createGovernor } from '../lib/governor.js';
import {
  SHODAN_SNAPSHOTS,
  SHODAN_COUNTRY_FACETS,
  SHODAN_DETAIL_FACETS,
  shodanCountParams,
  shodanSampleParams,
} from '../../core/layers/shodan/snapshots.js';

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

test('the exposure feeds validate, are registered, pinned, governed and cached', () => {
  assert.equal(validateFeeds(feeds), feeds);
  assert.deepEqual(
    feeds.map((f) => f.id),
    ['shodan', 'internetdb'],
  );
  for (const f of feeds) {
    assert.ok(registry.includes(f), `${f.id} is spread into proxy/feeds.js`);
    assert.equal(registry.filter((r) => r.id === f.id).length, 1, `${f.id} once`);
    assert.ok(f.allowPaths.length && f.allowQuery, `${f.id} pins path and query`);
    assert.ok(f.governor.ratePerMinute > 0);
    assert.ok(f.cache.ttlMs >= 3_600_000);
  }
  assert.deepEqual(feed('shodan').inject, [
    { secret: 'SHODAN_API_KEY', as: 'query', name: 'key' },
  ]);
  assert.equal(feed('internetdb').inject, undefined, 'keyless');
});

test('Shodan: the proxy pins exactly the curated snapshots core offers', () => {
  assert.deepEqual(
    SHODAN_SNAPSHOTS.map((s) => s.query),
    [...SHODAN_QUERIES],
  );
  assert.deepEqual([SHODAN_COUNTRY_FACETS, SHODAN_DETAIL_FACETS], [...SHODAN_FACETS]);
  for (const s of SHODAN_SNAPSHOTS) {
    assert.ok(admits('shodan', '/shodan/host/count', shodanCountParams(s)), s.id);
    assert.ok(admits('shodan', '/shodan/host/count', shodanCountParams(s, 'de')), s.id);
    assert.ok(admits('shodan', '/shodan/host/search', shodanSampleParams(s)), s.id);
  }
  assert.ok(admits('shodan', '/shodan/host/8.8.8.8', {}));
  assert.ok(admits('shodan', '/shodan/host/2001:4860:4860::8888', { minify: 'true' }));
});

test('Shodan: no free-text search, no extra pages, no client key', () => {
  const s = SHODAN_SNAPSHOTS[0];
  const count = shodanCountParams(s);
  assert.equal(
    admits('shodan', '/shodan/host/count', { ...count, query: 'apache' }),
    false,
  );
  assert.equal(
    admits('shodan', '/shodan/host/count', { ...count, query: `${s.query} city:Paris` }),
    false,
  );
  assert.equal(
    admits('shodan', '/shodan/host/count', { ...count, facets: 'ip:1000' }),
    false,
  );
  assert.equal(admits('shodan', '/shodan/host/count', { ...count, key: 'k' }), false);
  const sample = shodanSampleParams(s);
  assert.equal(admits('shodan', '/shodan/host/search', { ...sample, page: '2' }), false);
  assert.equal(admits('shodan', '/shodan/host/search', { query: s.query }), false);
  assert.equal(admits('shodan', '/shodan/host/countx', count), false);
  assert.equal(admits('shodan', '/shodan/host/search/facets', {}), false);
  assert.equal(admits('shodan', '/shodan/scan', {}), false);
  assert.equal(admits('shodan', '/dns/resolve', {}), false);
  assert.equal(shodanQueryTextOk(`${s.query} country:de`), false);
  assert.equal(shodanQueryOk(new URLSearchParams('query=a&query=b')), false);
});

test('Shodan: searches cost a credit, counts and lookups do not', () => {
  const g = createGovernor(feeds, () => 0);
  assert.equal(g.check('shodan', '/shodan/host/count').cost, 0);
  assert.equal(g.check('shodan', '/shodan/host/8.8.8.8').cost, 0);
  assert.equal(g.check('shodan', '/shodan/host/search').cost, 1);
  assert.ok(feed('shodan').governor.creditBudget < 100);
});

test('InternetDB: one IP per request, nothing else', () => {
  assert.ok(admits('internetdb', '/8.8.8.8'));
  assert.ok(admits('internetdb', '/45.33.32.156'));
  assert.ok(admits('internetdb', '/2001:4860:4860::8888'));
  assert.equal(admits('internetdb', '/256.1.1.1'), false);
  assert.equal(admits('internetdb', '/example.com'), false);
  assert.equal(admits('internetdb', '/8.8.8.8/extra'), false);
  assert.equal(admits('internetdb', '/'), false);
  assert.equal(admits('internetdb', '/8.8.8.8', { fields: 'x' }), false);
  assert.equal(admits('internetdb', '/1234'), false);
});
