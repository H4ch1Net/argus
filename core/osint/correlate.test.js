import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allAnnouncedPrefixes,
  announcedPrefixCount,
  parseShodanHost,
  createCorrelator,
} from './correlate.js';

test('allAnnouncedPrefixes maps + limits', () => {
  const json = {
    data: { prefixes: [{ prefix: 'a/24' }, { prefix: 'b/24' }, { prefix: 'c/24' }] },
  };
  assert.deepEqual(allAnnouncedPrefixes(json, 2), ['a/24', 'b/24']);
  assert.equal(announcedPrefixCount(json), 3);
  assert.deepEqual(allAnnouncedPrefixes({}, 5), []);
});

test('parseShodanHost pulls ports/hostnames/tags/vulns', () => {
  const s = parseShodanHost({
    ports: [80, 443],
    hostnames: ['dns.google'],
    tags: ['cdn'],
    vulns: { 'CVE-2021-1': {}, 'CVE-2021-2': {} },
    org: 'Google LLC',
  });
  assert.deepEqual(s.ports, [80, 443]);
  assert.deepEqual(s.hostnames, ['dns.google']);
  assert.equal(s.vulns.length, 2);
  assert.equal(s.org, 'Google LLC');
});

test('parseShodanHost tolerates junk', () => {
  assert.equal(parseShodanHost(null), null);
  const empty = parseShodanHost({});
  assert.deepEqual(empty.ports, []);
});

test('createCorrelator merges RIPEstat + Shodan into a sectioned composite', async () => {
  const ripe = {
    'network-info:8.8.8.8': { data: { asns: ['15169'], prefix: '8.8.8.0/24' } },
    'maxmind-geo-lite:8.8.8.8': {
      data: {
        located_resources: [
          { locations: [{ country: 'US', city: '', latitude: 37.7, longitude: -97.8 }] },
        ],
      },
    },
    'as-overview:AS15169': { data: { holder: 'GOOGLE - Google LLC', announced: true } },
    'announced-prefixes:AS15169': {
      data: { prefixes: [{ prefix: '8.8.8.0/24' }, { prefix: '8.8.4.0/24' }] },
    },
  };
  const proxyClient = {
    async getJson(feed, path, { params } = {}) {
      if (feed === 'ripestat') {
        // path is /<call>/data.json (relative to the ripestat /data base path).
        const call = path.split('/')[1];
        return ripe[`${call}:${params.resource}`] ?? null;
      }
      if (feed === 'shodan') {
        return {
          ports: [53, 443],
          hostnames: ['dns.google'],
          tags: [],
          org: 'Google LLC',
        };
      }
      return null;
    },
  };
  const correlate = createCorrelator({ proxyClient });
  const c = await correlate({ kind: 'ip', value: '8.8.8.8' });

  assert.equal(c.variant, 'correlated');
  assert.deepEqual(c.position, { longitude: -97.8, latitude: 37.7 });
  assert.deepEqual(c.sources, ['RIPEstat', 'Shodan']);
  const titles = c.card.sections.map((s) => s.title);
  assert.ok(titles.includes('Routing (RIPEstat)'));
  assert.ok(titles.includes('Exposure (Shodan)'));
  const exposure = c.card.sections.find((s) => s.title === 'Exposure (Shodan)');
  assert.deepEqual(
    exposure.rows.find((r) => r[0] === 'Open ports'),
    ['Open ports', '53, 443'],
  );
});

test('createCorrelator degrades gracefully when Shodan is absent', async () => {
  const proxyClient = {
    async getJson(feed, path) {
      if (feed === 'ripestat' && path.includes('network-info')) {
        return { data: { asns: [], prefix: '203.0.113.0/24' } };
      }
      if (feed === 'ripestat' && path.includes('maxmind')) {
        return {
          data: {
            located_resources: [
              {
                locations: [
                  { country: 'NL', city: 'Amsterdam', latitude: 52.3, longitude: 4.9 },
                ],
              },
            ],
          },
        };
      }
      if (feed === 'shodan') throw new Error('no key');
      return null;
    },
  };
  const c = await createCorrelator({ proxyClient })({ kind: 'ip', value: '203.0.113.9' });
  assert.deepEqual(c.sources, ['RIPEstat']);
  assert.ok(!c.card.sections.some((s) => s.title === 'Exposure (Shodan)'));
});
