import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  reverseParams,
  parseReverse,
  reversePlace,
  resetReverseMemo,
} from './reverse.js';

const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('a point to five decimals, one answer', () => {
  assert.deepEqual(reverseParams(33.714912, -116.210281), {
    lat: '33.71491',
    lon: '-116.21028',
    limit: '1',
  });
  assert.deepEqual(reverseParams(33.714912, -116.210281, 4), {
    lat: '33.7149',
    lon: '-116.2103',
    limit: '1',
  });
  assert.equal(reverseParams(95, 0), null);
  assert.equal(reverseParams('x', 0), null);
});

test('real answers (Photon, Oct 2026): the street and the town', () => {
  assert.deepEqual(parseReverse(fixture('photon-reverse-hwy111-golf.json')), {
    name: '46th Avenue',
    detail: 'Indio, California',
    city: 'Indio',
    state: 'California',
    country: 'United States',
  });
  assert.equal(
    parseReverse(fixture('photon-reverse-46211-jackson.json')).name,
    'Jackson Street',
  );
  // An address leads with its number in the US; a place keeps its own name.
  const addr = parseReverse({
    features: [
      {
        properties: {
          housenumber: '46211',
          street: 'Jackson Street',
          city: 'Indio',
          state: 'California',
          countrycode: 'US',
        },
      },
    ],
  });
  assert.equal(addr.name, '46211 Jackson Street');
  assert.equal(addr.detail, 'Indio, California');
  const poi = parseReverse({
    features: [
      {
        properties: {
          name: 'Indio Fashion Mall',
          street: 'Monroe Street',
          housenumber: '82',
          city: 'Indio',
          countrycode: 'US',
        },
      },
    ],
  });
  assert.equal(poi.name, 'Indio Fashion Mall');
  assert.equal(poi.detail, '82 Monroe Street, Indio');
  assert.equal(parseReverse({ features: [] }), null);
});

test('asked once per point; a failure is not remembered', async () => {
  resetReverseMemo();
  let calls = 0;
  let fail = true;
  const client = {
    getJson: async (feed, path, { params }) => {
      calls += 1;
      assert.equal(feed, 'photon-reverse');
      assert.equal(path, '/reverse');
      assert.equal(params.lat, '33.71491');
      if (fail) throw new Error('busy');
      return fixture('photon-reverse-hwy111-golf.json');
    },
  };
  assert.equal(await reversePlace(client, 33.714912, -116.21028), null);
  fail = false;
  assert.equal((await reversePlace(client, 33.714912, -116.21028)).name, '46th Avenue');
  await reversePlace(client, 33.714912, -116.21028);
  assert.equal(calls, 2);
  assert.equal(await reversePlace(null, 1, 2), null);
});
