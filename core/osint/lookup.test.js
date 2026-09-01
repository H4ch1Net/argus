import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGeo,
  parseNetworkInfo,
  parseAsOverview,
  firstForwardIpv4,
  firstAnnouncedPrefix,
  createLookup,
} from './lookup.js';

test('parseGeo pulls the first located location', () => {
  const g = parseGeo({
    data: {
      located_resources: [
        { locations: [{ country: 'US', city: '', latitude: 37.7, longitude: -97.8 }] },
      ],
    },
  });
  assert.deepEqual(g, { latitude: 37.7, longitude: -97.8, country: 'US', city: '' });
});

test('parseGeo returns null when coordinates are missing', () => {
  assert.equal(parseGeo({ data: { located_resources: [] } }), null);
  assert.equal(parseGeo({}), null);
});

test('parseNetworkInfo returns prefix + asns', () => {
  assert.deepEqual(
    parseNetworkInfo({ data: { asns: ['15169'], prefix: '8.8.8.0/24' } }),
    {
      prefix: '8.8.8.0/24',
      asns: ['15169'],
    },
  );
});

test('parseAsOverview returns holder + announced', () => {
  assert.deepEqual(
    parseAsOverview({ data: { holder: 'GOOGLE - Google LLC', announced: true } }),
    {
      holder: 'GOOGLE - Google LLC',
      announced: true,
    },
  );
});

test('firstForwardIpv4 prefers a v4 address', () => {
  const json = {
    data: { forward_nodes: { 'dns.google': ['2001:4860:4860::8888', '8.8.4.4'] } },
  };
  assert.equal(firstForwardIpv4(json, 'dns.google'), '8.8.4.4');
});

test('firstAnnouncedPrefix reads the first prefix', () => {
  assert.equal(
    firstAnnouncedPrefix({ data: { prefixes: [{ prefix: '8.8.8.0/24' }] } }),
    '8.8.8.0/24',
  );
});

test('createLookup enriches an IP via the (faked) proxy and geolocates it', async () => {
  const responses = {
    'maxmind-geo-lite:8.8.8.8': {
      data: {
        located_resources: [
          { locations: [{ country: 'US', city: '', latitude: 37.7, longitude: -97.8 }] },
        ],
      },
    },
    'network-info:8.8.8.8': { data: { asns: ['15169'], prefix: '8.8.8.0/24' } },
    'as-overview:AS15169': { data: { holder: 'GOOGLE - Google LLC', announced: true } },
  };
  const proxyClient = {
    async getJson(_feed, path, { params }) {
      // path is /<call>/data.json (relative to the ripestat /data base path).
      const call = path.split('/')[1];
      return responses[`${call}:${params.resource}`];
    },
  };
  const lookup = createLookup(proxyClient);
  const r = await lookup({ kind: 'ip', value: '8.8.8.8' });
  assert.equal(r.kind, 'ip');
  assert.deepEqual(r.position, { longitude: -97.8, latitude: 37.7 });
  assert.equal(r.card.title, '8.8.8.8');
  const operator = r.card.rows.find((row) => row[0] === 'Operator');
  assert.deepEqual(operator, ['Operator', 'GOOGLE - Google LLC']);
});
