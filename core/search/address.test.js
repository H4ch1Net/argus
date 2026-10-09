import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseAddress,
  censusAddress,
  nominatimAddressParams,
  nominatimPlaces,
  lookupAddress,
} from './address.js';
import {
  CENSUS_FEED,
  CENSUS_PATH,
  censusParams,
  parseCensus,
  titleWords,
} from './census.js';
import {
  PHOTON_REVERSE_FEED,
  regionParams,
  parseRegion,
  createRegionLookup,
} from './region.js';

const fixture = (name) =>
  JSON.parse(
    fs.readFileSync(new URL(`../nav/fixtures/${name}`, import.meta.url), 'utf8'),
  );
const INDIO = { lat: 33.72, lon: -116.21 };
const CA = { city: 'Coachella', state: 'California', countryCode: 'US' };

test('address detection: a house number, then a street word of 3+ letters', () => {
  assert.deepEqual(parseAddress('46211 Jackson street'), {
    number: '46211',
    street: 'Jackson street',
    region: false,
  });
  assert.equal(parseAddress('12B Main St').number, '12b');
  assert.equal(parseAddress('1600-A Elm Ave').number, '1600');
  assert.equal(parseAddress('46211 J'), null); // still typing
  assert.equal(parseAddress('Jackson street'), null);
  assert.equal(parseAddress('Highway 111'), null);
  assert.equal(parseAddress('2026'), null);
  // A state or ZIP already in the query.
  assert.equal(parseAddress('46211 Jackson St, Indio, CA').region, true);
  assert.equal(parseAddress('46211 Jackson St Indio California').region, true);
  assert.equal(parseAddress('46211 Jackson St 92201').region, true);
  assert.equal(parseAddress('46211 Jackson St, Indio').region, false);
});

test('the Census line: the user state appended, or the query as typed, or none', () => {
  assert.equal(
    censusAddress('46211 Jackson street', CA),
    '46211 Jackson street, California',
  );
  assert.equal(
    censusAddress('46211 Jackson street', CA, { city: true }),
    '46211 Jackson street, Coachella, California',
  );
  assert.equal(censusAddress('46211 Jackson St, CA', null), '46211 Jackson St, CA');
  // Outside the US, or no idea where the user is: not a Census question.
  assert.equal(
    censusAddress('10 Downing Street', { state: 'England', countryCode: 'GB' }),
    null,
  );
  assert.equal(censusAddress('46211 Jackson street', null), null);
  assert.equal(censusAddress('Jackson street', CA), null);
  assert.deepEqual(censusParams('  46211  Jackson street, California '), {
    address: '46211 Jackson street, California',
    benchmark: 'Public_AR_Current',
    format: 'json',
  });
});

test('Census (real answer) -> the address in Indio, title-cased', () => {
  const [p, ...rest] = parseCensus(fixture('census-46211-jackson-ca.json'));
  assert.equal(rest.length, 0);
  assert.deepEqual(p, {
    id: 'census:647490048:46211:33.71306,-116.21643',
    name: '46211 Jackson St',
    detail: 'Indio, CA 92201',
    lat: 33.713061051136,
    lon: -116.216430954132,
    kind: 'address',
    number: '46211',
  });
  assert.deepEqual(parseCensus(fixture('census-46211-jackson-ky.json')), []);
  assert.deepEqual(parseCensus(null), []);
  assert.equal(titleWords('100 N MAIN ST'), '100 N Main St');
});

test('Photon reverse (real answer) -> the region the user is in', () => {
  assert.deepEqual(parseRegion(fixture('photon-reverse-indio.json')), {
    city: 'Coachella',
    state: 'California',
    country: 'United States',
    countryCode: 'US',
    postcode: '92201',
  });
  assert.equal(parseRegion(fixture('photon-reverse-cincinnati.json')).state, 'Kentucky');
  assert.equal(parseRegion({ features: [] }), null);
  assert.deepEqual(regionParams({ lat: 33.7234, lon: -116.2061 }), {
    lat: '33.7',
    lon: '-116.2',
    limit: '1',
  });
  assert.equal(regionParams({ lat: 95, lon: 0 }), null);
});

test('the region is asked once per area; a failure is not remembered', async () => {
  let calls = 0;
  let fail = true;
  const client = {
    getJson: async (feed) => {
      assert.equal(feed, PHOTON_REVERSE_FEED);
      calls += 1;
      if (fail) throw new Error('down');
      return fixture('photon-reverse-indio.json');
    },
  };
  const lookup = createRegionLookup(client);
  await assert.rejects(lookup(INDIO), /down/);
  fail = false;
  assert.equal((await lookup(INDIO)).state, 'California');
  assert.equal((await lookup({ lat: 33.71, lon: -116.24 })).state, 'California');
  assert.equal(calls, 2);
});

test('Nominatim: params biased to a box around the user, answers as Places', () => {
  assert.deepEqual(nominatimAddressParams('46211 Jackson street', INDIO), {
    q: '46211 Jackson street',
    format: 'jsonv2',
    addressdetails: '1',
    limit: '5',
    viewbox: '-116.71,34.22,-115.71,33.22',
  });
  assert.equal(nominatimAddressParams('x').viewbox, undefined);
  const [a, b] = nominatimPlaces([
    {
      osm_type: 'node',
      osm_id: 123,
      lat: '33.7144314',
      lon: '-116.2162142',
      type: 'house',
      address: {
        house_number: '46211',
        road: 'Jackson Street',
        city: 'Indio',
        state: 'California',
        postcode: '92201',
      },
    },
    // format=json without address details (as answered live, Oct 2026).
    {
      lat: '33.7130010',
      lon: '-116.2164614',
      display_name:
        '46211, Jackson Street, Indio, Riverside County, California, 92201, United States',
    },
  ]);
  assert.deepEqual(a, {
    id: 'osm:N123',
    name: '46211 Jackson Street',
    detail: 'Indio, California, 92201',
    lat: 33.7144314,
    lon: -116.2162142,
    kind: 'address',
  });
  assert.equal(b.name, '46211 Jackson Street');
});

function replay(answers) {
  const calls = [];
  return {
    calls,
    getJson: async (feed, path, opts) => {
      calls.push({ feed, path, params: opts?.params });
      const a = answers[feed];
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(opts?.params) : (a ?? null);
    },
  };
}

test('a US address: the user state from the region, then Census; no Nominatim', async () => {
  const client = replay({
    [CENSUS_FEED]: fixture('census-46211-jackson-ca.json'),
    nominatim: new Error('must not be asked'),
  });
  const out = await lookupAddress(client, '46211 Jackson street', {
    near: INDIO,
    region: async () => parseRegion(fixture('photon-reverse-indio.json')),
    settleMs: 0,
  });
  assert.equal(out[0].name, '46211 Jackson St');
  assert.deepEqual(client.calls, [
    {
      feed: CENSUS_FEED,
      path: CENSUS_PATH,
      params: censusParams('46211 Jackson street, California'),
    },
  ]);
});

test('no such number from Census (or not the US): Nominatim around the user', async () => {
  const nominatim = [
    {
      lat: '33.71',
      lon: '-116.21',
      address: { house_number: '46211', road: 'Jackson Street', city: 'Indio' },
    },
  ];
  // The user's view is in Kentucky: Census has no 46211 Jackson there.
  let client = replay({
    [CENSUS_FEED]: fixture('census-46211-jackson-ky.json'),
    nominatim,
  });
  let out = await lookupAddress(client, '46211 Jackson street', {
    near: { lat: 39.1, lon: -84.5 },
    region: async () => parseRegion(fixture('photon-reverse-cincinnati.json')),
    settleMs: 0,
  });
  assert.deepEqual(
    client.calls.map((c) => c.feed),
    [CENSUS_FEED, 'nominatim'],
  );
  assert.equal(client.calls[0].params.address, '46211 Jackson street, Kentucky');
  assert.equal(client.calls[1].params.viewbox, '-85,39.6,-84,38.6');
  assert.equal(out[0].name, '46211 Jackson Street');
  // Abroad: Nominatim only. A failing provider is not an error.
  client = replay({ nominatim: new Error('429') });
  out = await lookupAddress(client, '10 Downing Street', {
    near: { lat: 51.5, lon: -0.13 },
    region: async () => ({ state: 'England', countryCode: 'GB' }),
    settleMs: 0,
  });
  assert.deepEqual(out, []);
  assert.deepEqual(
    client.calls.map((c) => c.feed),
    ['nominatim'],
  );
});

test('a statewide answer with nothing near asks again with the city', async () => {
  const far = (i) => ({
    matchedAddress: `100 MAIN ST, TOWN${i}, CA, 9${String(i).padStart(4, '0')}`,
    coordinates: { x: -122 + i * 0.01, y: 38 },
    tigerLine: { tigerLineId: String(i) },
  });
  const local = {
    matchedAddress: '100 MAIN ST, COACHELLA, CA, 92236',
    coordinates: { x: -116.17, y: 33.68 },
    tigerLine: { tigerLineId: 'x' },
  };
  const client = replay({
    [CENSUS_FEED]: (params) => ({
      result: {
        addressMatches: /Coachella/.test(params.address)
          ? [local]
          : Array.from({ length: 50 }, (_, i) => far(i)),
      },
    }),
  });
  const out = await lookupAddress(client, '100 Main St', {
    near: INDIO,
    region: async () => CA,
    settleMs: 0,
  });
  assert.equal(out[0].detail, 'Coachella, CA 92236');
  assert.deepEqual(
    client.calls.map((c) => c.params.address),
    ['100 Main St, California', '100 Main St, Coachella, California'],
  );
});

test('typing on: an older search leaves Nominatim to the newer one', async () => {
  const client = replay({ nominatim: [] });
  const first = lookupAddress(client, '46211 Jack', { settleMs: 30 });
  const second = lookupAddress(client, '46211 Jackson', { settleMs: 30 });
  await Promise.all([first, second]);
  assert.deepEqual(
    client.calls.map((c) => c.params.q),
    ['46211 Jackson'],
  );
  // The caller's abort stops it too.
  const ac = new AbortController();
  const p = lookupAddress(client, '46211 Jackson st', {
    settleMs: 30,
    signal: ac.signal,
  });
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
});
