import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNominatim, createGeocoder, mergePlaces } from './geocoder.js';

test('parses Nominatim results into name/lon/lat', () => {
  const out = parseNominatim([
    { display_name: 'Paris, France', lon: '2.3488', lat: '48.8534' },
    { display_name: 'Paris, Texas', lon: '-95.55', lat: '33.66' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Paris, France');
  assert.equal(out[0].longitude, 2.3488);
  assert.equal(out[0].latitude, 48.8534);
});

test('skips entries with bad coordinates or no name', () => {
  const out = parseNominatim([
    { display_name: 'Nowhere', lon: 'x', lat: '1' },
    { lon: '1', lat: '2' },
    { display_name: 'OK', lon: '10', lat: '20' },
  ]);
  assert.deepEqual(out, [{ name: 'OK', longitude: 10, latitude: 20 }]);
});

test('tolerates non-arrays', () => {
  assert.deepEqual(parseNominatim(null), []);
  assert.deepEqual(parseNominatim({}), []);
});

// --- the chain: offline places, then Photon, then Nominatim ------------------

function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    getJson: async (feed, path, opts) => {
      calls.push({ feed, path, params: opts?.params });
      const a = answers[feed];
      if (a instanceof Error) throw a;
      return a ?? null;
    },
  };
}

const photonHit = (name, lon, lat) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { name, country: 'X' },
});

test('an exact bundled name answers with no request at all', async () => {
  const client = fakeClient({});
  const out = await createGeocoder(client)('Paris');
  assert.equal(out[0].name, 'Paris, France');
  assert.equal(client.calls.length, 0);
  // With no proxy at all, the offline list is the whole chain.
  assert.equal((await createGeocoder(null)('lond'))[0].name, 'London, United Kingdom');
});

test('Photon is asked next, with the view as a soft bias', async () => {
  const client = fakeClient({
    photon: { features: [photonHit('Hoan Kiem Lake', 105.85, 21.03)] },
  });
  const out = await createGeocoder(client, { near: () => ({ lat: 30.27, lon: -97.74 }) })(
    'hoan kiem',
  );
  assert.equal(out[0].name, 'Hoan Kiem Lake, X');
  assert.deepEqual(client.calls, [
    {
      feed: 'photon',
      path: '/api/',
      params: { q: 'hoan kiem', limit: 5, lat: 30.3, lon: -97.7 },
    },
  ]);
});

test('Nominatim is the last resort when Photon fails or finds nothing', async () => {
  const nominatim = [{ display_name: 'Paris, Texas', lon: '-95.55', lat: '33.66' }];
  let client = fakeClient({ photon: new Error('proxy photon responded 429'), nominatim });
  assert.equal((await createGeocoder(client)('Paris, Texas'))[0].name, 'Paris, Texas');
  assert.deepEqual(
    client.calls.map((c) => c.feed),
    ['photon', 'nominatim'],
  );
  client = fakeClient({ photon: { features: [] }, nominatim });
  assert.equal((await createGeocoder(client)('Paris, Texas')).length, 1);
  // Everything failed and nothing offline: the failure is reported, not hidden.
  client = fakeClient({ photon: new Error('down'), nominatim: new Error('also down') });
  await assert.rejects(createGeocoder(client)('qqqq zzzz'), /also down/);
});

test('offline prefix hits lead, and the same place from the network is not repeated', () => {
  const offline = [
    { name: 'London, United Kingdom', latitude: 51.51, longitude: -0.13 },
    { name: 'Longyearbyen, Svalbard', latitude: 78.22, longitude: 15.65 },
    { name: 'Third', latitude: 0, longitude: 0 },
  ];
  const network = [
    { name: 'London, England, United Kingdom', latitude: 51.507, longitude: -0.128 },
    { name: 'London Eye, London', latitude: 51.503, longitude: -0.119 },
    { name: 'London, Ontario, Canada', latitude: 42.98, longitude: -81.25 },
  ];
  assert.deepEqual(
    mergePlaces(offline, network).map((p) => p.name),
    [
      'London, United Kingdom',
      'Longyearbyen, Svalbard',
      'London Eye, London',
      'London, Ontario, Canada',
    ],
  );
  assert.equal(mergePlaces(offline, []).length, 3);
});
