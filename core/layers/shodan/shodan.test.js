import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShodanFacetList, parseShodanSample, shodanToNormalized } from './parse.js';
import { describeShodan, facetText, compactCount } from './format.js';
import {
  SHODAN_SNAPSHOTS,
  snapshotById,
  shodanCountParams,
  shodanSampleParams,
} from './snapshots.js';
import { createShodanSource, fetchCountryFacets } from './source.js';
import { createShodanExtras } from './extras.js';
import { createShodanMockSource } from './mockSource.js';
import { SETTINGS_SCHEMA } from '../../settings/store.js';

// /shodan/host/search with minify=true, the documented match shape (trimmed;
// documentation addresses). Not live-tested: no Shodan key here.
const SAMPLE = {
  total: 3,
  matches: [
    {
      ip_str: '203.0.113.7',
      port: 443,
      org: 'Example Hosting',
      asn: 'AS64500',
      hostnames: ['a.example.net'],
      product: 'nginx',
      location: {
        latitude: 52.37,
        longitude: 4.9,
        country_code: 'NL',
        city: 'Amsterdam',
      },
    },
    {
      ip_str: '203.0.113.7',
      port: 80,
      product: 'nginx',
      location: { latitude: 52.37, longitude: 4.9, country_code: 'NL' },
    },
    { ip_str: '198.51.100.1', port: 22, location: { latitude: null, longitude: null } },
  ],
};

test('snapshots: curated, no free text, settings in step', () => {
  assert.equal(snapshotById('nope').id, 'web');
  assert.deepEqual(shodanCountParams(snapshotById('rdp')), {
    query: 'port:3389',
    facets: 'country:200',
  });
  assert.deepEqual(shodanCountParams(snapshotById('web'), 'de'), {
    query: 'product:"Apache httpd" country:DE',
    facets: 'port:8,org:8,product:8',
  });
  assert.throws(() => shodanCountParams(snapshotById('web'), 'Germany'));
  assert.deepEqual(shodanSampleParams(snapshotById('rdp')), {
    query: 'port:3389',
    page: '1',
    minify: 'true',
  });
  assert.deepEqual(
    SETTINGS_SCHEMA.shodanSnapshot.values,
    SHODAN_SNAPSHOTS.map((s) => s.id),
  );
  // Infrastructure categories only: nothing that looks at cameras or people.
  for (const s of SHODAN_SNAPSHOTS)
    assert.doesNotMatch(s.query, /screenshot|webcam|camera/i);
});

test('the host sample: one point per IP with its ports, unplaceable hosts skipped', () => {
  const hosts = parseShodanSample(SAMPLE);
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].ip, '203.0.113.7');
  assert.deepEqual(hosts[0].ports, [80, 443]);
  assert.deepEqual(hosts[0].products, ['nginx']);
  const all = shodanToNormalized({
    count: { total: 10, facets: { country: [{ value: 'NL', count: 10 }] } },
    snapshot: snapshotById('web'),
    sample: SAMPLE,
  });
  assert.deepEqual(
    all.map((n) => n.type),
    ['shodan-density', 'shodan-host'],
  );
  assert.equal(all[0].meta.snapshot, 'Web servers (Apache)');
  assert.equal(all[0].meta.source, 'Shodan');
  const host = describeShodan(all[1]);
  assert.equal(host.title, '203.0.113.7');
  assert.equal(Object.fromEntries(host.rows).Ports, '80, 443');
  assert.equal(host.links[0].url, 'https://www.shodan.io/host/203.0.113.7');
  const country = Object.fromEntries(describeShodan(all[0]).rows);
  assert.equal(country.Share, '100.0% of the snapshot');
  assert.equal(country.Rank, '#1');
});

test('facets and counts read compactly', () => {
  const json = {
    facets: {
      port: [
        { value: 443, count: 1_234_567 },
        { value: 80, count: 45_600 },
      ],
    },
  };
  const ports = parseShodanFacetList(json, 'port');
  assert.deepEqual(ports, [
    { value: '443', count: 1_234_567 },
    { value: '80', count: 45_600 },
  ]);
  assert.equal(facetText(ports), '443 (1.2M), 80 (46K)');
  assert.equal(compactCount(999), '999');
  assert.equal(facetText([]), '—');
});

test('the source: one count per snapshot, the sample only when switched on', async () => {
  const calls = [];
  const proxyClient = {
    async getJson(feed, path, { params }) {
      calls.push([feed, path, params]);
      if (path.endsWith('/search')) return SAMPLE;
      return { total: 5, facets: { country: [{ value: 'US', count: 5 }] } };
    },
  };
  let sample = false;
  const src = createShodanSource({
    proxyClient,
    getSnapshot: () => 'mqtt',
    getSample: () => sample,
  });
  const a = await src();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    'shodan',
    '/shodan/host/count',
    { query: 'port:1883', facets: 'country:200' },
  ]);
  assert.equal(a.sample, null);
  sample = true;
  const b = await src();
  assert.equal(calls[2][1], '/shodan/host/search');
  assert.equal(shodanToNormalized(b).filter((n) => n.type === 'shodan-host').length, 1);
  // A refused sample (budget spent) leaves the density map standing.
  const failing = createShodanSource({
    proxyClient: {
      async getJson(_f, path) {
        if (path.endsWith('/search'))
          throw Object.assign(new Error('429'), { status: 429 });
        return { total: 1, facets: { country: [{ value: 'US', count: 1 }] } };
      },
    },
    getSample: () => true,
  });
  const c = await failing();
  assert.equal(c.sample, null);
  assert.equal(shodanToNormalized(c).length, 1);
});

test('country facets on the card, fetched once per snapshot and country', async () => {
  const calls = [];
  const proxyClient = {
    async getJson(_f, _p, { params }) {
      calls.push(params.query);
      return {
        total: 900,
        facets: {
          port: [{ value: 443, count: 500 }],
          org: [{ value: 'Example', count: 300 }],
          product: [{ value: 'nginx', count: 200 }],
        },
      };
    },
  };
  const f = await fetchCountryFacets(proxyClient, 'web', 'DE');
  assert.equal(f.total, 900);
  assert.deepEqual(Object.fromEntries(f.rows)['Top ports'], '443 (500)');
  const extras = createShodanExtras({
    fetchFacets: (id, cc) => fetchCountryFacets(proxyClient, id, cc),
    getSnapshot: () => 'web',
  });
  const n = { type: 'shodan-density', meta: { country: 'DE' } };
  let refreshed = 0;
  const ctx = { refresh: () => (refreshed += 1) };
  assert.deepEqual(extras.rows('shodan', n), []);
  await extras.onSelect('shodan', n, ctx);
  await extras.onSelect('shodan', n, ctx);
  assert.equal(calls.filter((q) => q.endsWith('country:DE')).length, 2); // one above, one here
  assert.ok(refreshed >= 2);
  assert.equal(
    Object.fromEntries(extras.rows('shodan', n))['Top operators'],
    'Example (300)',
  );
  assert.deepEqual(extras.rows('flights', n), []);
});

test('the dev mock scales per snapshot and marks itself DEMO', async () => {
  const web = shodanToNormalized(await createShodanMockSource()());
  const vnc = shodanToNormalized(
    await createShodanMockSource({ getSnapshot: () => 'vnc', getSample: () => true })(),
  );
  assert.equal(web[0].meta.source, 'demo (simulated)');
  assert.ok(vnc[0].meta.count < web[0].meta.count);
  assert.ok(vnc.some((n) => n.type === 'shodan-host'));
});
