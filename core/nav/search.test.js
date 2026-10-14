import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  photonPlaces,
  tomtomPlaces,
  tomtomSearchRequest,
  offlinePlaces,
  mergePlaces,
  searchDestinations,
  reverseName,
  savedShortlist,
  savedPlace,
  SAVED_QUERY,
} from './search.js';
import { resetRegionMemo } from '../search/region.js';
import { resetReverseMemo } from '../search/reverse.js';
import { createPlacesStore } from '../places/saved.js';
import { createRecents } from '../places/recents.js';

const fixture = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const PLACE_KEYS = ['detail', 'id', 'kind', 'lat', 'lon', 'name'];

test('Photon (real answer) -> Places with a name and where it is', () => {
  const places = photonPlaces(fixture('photon-ferry-building.json'));
  assert.equal(places.length, 4);
  for (const p of places) assert.deepEqual(Object.keys(p).sort(), PLACE_KEYS);
  assert.deepEqual(places[0], {
    id: 'osm:N6933256729',
    name: 'Ferry Building',
    detail: 'Harry Bridges Plaza, Financial District, San Francisco, California',
    lat: 37.7947815,
    lon: -122.393678,
    kind: 'railway=stop',
  });
  // A bare address leads with street and number.
  const [addr] = photonPlaces({
    features: [
      {
        geometry: { type: 'Point', coordinates: [2.35, 48.86] },
        properties: { street: 'Rue de Rivoli', housenumber: '10', city: 'Paris' },
      },
    ],
  });
  assert.equal(addr.name, 'Rue de Rivoli 10');
  assert.equal(addr.detail, 'Paris');
});

test('TomTom search (documented shape): request pinned, entrances preferred', () => {
  const r = tomtomSearchRequest(
    'ferry building / sf',
    { lat: 37.78123, lon: -122.41 },
    50,
  );
  assert.equal(r.feed, 'tomtom-search');
  assert.equal(r.path, '/search/ferry%20building%20%2F%20sf.json');
  assert.deepEqual(r.params, {
    limit: 10,
    typeahead: 'true',
    language: 'en-GB',
    lat: 37.781,
    lon: -122.41,
  });
  const places = tomtomPlaces(fixture('tomtom-search-documented.json'));
  assert.equal(places.length, 2, 'the broken result is skipped');
  assert.equal(places[0].name, 'Ferry Building Marketplace');
  assert.equal(places[0].detail, '1 Ferry Building, San Francisco, CA 94111');
  assert.deepEqual(
    [places[0].lat, places[0].lon],
    [37.79531, -122.39385],
    'the entrance',
  );
  assert.equal(places[0].kind, 'shop');
  assert.equal(places[1].name, 'Ferry Plaza, San Francisco, CA');
  assert.equal(places[1].kind, 'street');
});

test('merge: exact offline first, network interleaved, near duplicates dropped', () => {
  const off = offlinePlaces([
    { name: 'Paris, France', latitude: 48.86, longitude: 2.35, exact: true },
  ]).map((p) => ({ ...p, exact: true }));
  const a = [
    { id: 'a1', name: 'Paris', detail: '', lat: 48.8601, lon: 2.3501, kind: 'x' },
    {
      id: 'a2',
      name: 'Paris Gare de Lyon',
      detail: '',
      lat: 48.84,
      lon: 2.37,
      kind: 'x',
    },
  ];
  const b = [
    {
      id: 'b1',
      name: 'Paris Hilton Hotel',
      detail: '',
      lat: 48.85,
      lon: 2.29,
      kind: 'x',
    },
  ];
  const out = mergePlaces(off, [a, b], 8);
  assert.deepEqual(
    out.map((p) => p.id),
    ['place:Paris, France', 'b1', 'a2'],
  );
  assert.equal('exact' in out[0], false);
});

test('searchDestinations: offline with no proxy; one network failure does not hide the other', async () => {
  assert.deepEqual(
    (await searchDestinations(null, 'tokyo')).map((p) => p.name),
    ['Tokyo'],
  );
  const asked = [];
  const client = {
    getJson: async (feed, path, opts) => {
      asked.push([feed, path, opts.params]);
      if (feed === 'tomtom-search')
        throw Object.assign(new Error('502'), { status: 502 });
      return fixture('photon-ferry-building.json');
    },
  };
  const out = await searchDestinations(client, 'ferry building', {
    near: { lat: 37.78, lon: -122.41 },
    tomtom: true,
  });
  assert.equal(out[0].name, 'Ferry Building');
  assert.deepEqual(
    asked.map((a) => a[0]),
    ['tomtom-search', 'photon'],
  );
  assert.equal(asked[1][2].lat, 37.8);
  const down = { getJson: async () => Promise.reject(new Error('down')) };
  await assert.rejects(searchDestinations(down, 'ferry building'), /down/);
});

test('reverseName: a short name for a dropped pin, null when nothing answers', async () => {
  const client = {
    getJson: async (feed, path, { params }) => {
      assert.equal(feed, 'nominatim');
      assert.equal(path, '/reverse');
      assert.equal(params.format, 'jsonv2');
      return {
        name: '',
        display_name: '1500, Folsom Street, San Francisco',
        address: {
          house_number: '1500',
          road: 'Folsom Street',
          city: 'San Francisco',
          country: 'United States',
        },
      };
    },
  };
  assert.deepEqual(await reverseName(client, 37.77, -122.41), {
    name: '1500 Folsom Street',
    detail: 'San Francisco, United States',
  });
  assert.equal(
    await reverseName({ getJson: async () => Promise.reject(new Error('x')) }, 1, 1),
    null,
  );
  assert.equal(await reverseName(null, 1, 1), null);
});

// --- local first: the owner's report, with the real answers (Oct 2026) -------

/** Replays the saved real answers by feed; records what was asked. */
function replay(answers) {
  const asked = [];
  return {
    asked,
    getJson: async (feed, path, opts) => {
      asked.push({ feed, path, params: opts?.params });
      const a = answers[feed];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new Error(`unexpected feed ${feed}`);
      return a;
    },
  };
}
const INDIO = { lat: 33.72, lon: -116.21 };
const near = (p, q, km) =>
  haversineKm(p.lat, p.lon, q.lat, q.lon) < km
    ? true
    : `${p.name} is ${haversineKm(p.lat, p.lon, q.lat, q.lon).toFixed(1)} km away`;
const haversineKm = (a, b, c, d) => {
  const r = Math.PI / 180;
  const h =
    Math.sin(((c - a) * r) / 2) ** 2 +
    Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

test('"46211 Jackson street" near Indio finds the address in Indio first', async () => {
  resetRegionMemo();
  const client = replay({
    photon: fixture('photon-46211-jackson-indio.json'),
    'photon-reverse': fixture('photon-reverse-indio.json'),
    'census-geocoder': fixture('census-46211-jackson-ca.json'),
  });
  const out = await searchDestinations(client, '46211 Jackson street', { near: INDIO });
  assert.equal(out[0].name, '46211 Jackson St');
  assert.equal(out[0].detail, 'Indio, CA 92201');
  assert.equal(near(out[0], { lat: 33.7131, lon: -116.2164 }, 0.2), true);
  for (const p of out.slice(1)) assert.equal(near(p, INDIO, 30), true); // the local streets
  for (const p of out) assert.deepEqual(Object.keys(p).sort(), PLACE_KEYS);
  // Photon biased to the user, the region once, Census with the state; no Nominatim.
  assert.deepEqual(client.asked.map((a) => a.feed).sort(), [
    'census-geocoder',
    'photon',
    'photon-reverse',
  ]);
  assert.equal(
    client.asked.find((a) => a.feed === 'census-geocoder').params.address,
    '46211 Jackson street, California',
  );
  // Asked again nearby: the region is remembered.
  client.asked.length = 0;
  await searchDestinations(client, '46211 Jackson street', { near: INDIO });
  assert.equal(
    client.asked.some((a) => a.feed === 'photon-reverse'),
    false,
  );
});

test('US addresses from Photon lead with the house number', () => {
  const [, , coachella] = photonPlaces(fixture('photon-walmart-indio.json'));
  assert.equal(coachella.name, 'Walmart Neighborhood Market');
  assert.match(coachella.detail, /^83053 Avenue 48, Coachella/);
});

test('the report: biased to a view over Cincinnati, Photon answers Cincinnati', async () => {
  // What the phone saw: the search leaned on a view centre in the Ohio
  // valley, not on the user (core/ui/navPanel.js and the launcher now lean on
  // the user's position, else the last known one). With that bias the
  // answers stay local to it, and a house number nobody has is not invented.
  resetRegionMemo();
  const client = replay({
    photon: fixture('photon-jackson-cincinnati.json'),
    'photon-reverse': fixture('photon-reverse-cincinnati.json'),
    'census-geocoder': fixture('census-46211-jackson-ky.json'),
    nominatim: fixture('nominatim-46211-jackson-cincinnati.json'),
  });
  const cincinnati = { lat: 39.1, lon: -84.5 };
  const out = await searchDestinations(client, '46211 Jackson street', {
    near: cincinnati,
  });
  assert.match(out[0].name, /^Jackson Street$/);
  assert.equal(near(out[0], cincinnati, 15), true);
  assert.equal(
    client.asked.find((a) => a.feed === 'census-geocoder').params.address,
    '46211 Jackson street, Kentucky',
  );
});

// --- saved places, recents and street crossings (round 8) --------------------

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) };
};
const roadsFixture = JSON.parse(
  fs.readFileSync(
    new URL('../search/fixtures/indio-roads.json', import.meta.url),
    'utf8',
  ),
);
const reverseFixture = JSON.parse(
  fs.readFileSync(
    new URL('../search/fixtures/photon-reverse-hwy111-golf.json', import.meta.url),
    'utf8',
  ),
);
const HERE = { lat: 33.7206, lon: -116.2156 };

function savedSetup() {
  const st = memory();
  const places = createPlacesStore(st);
  const recents = createRecents(st);
  places.add({ name: '46211 Jackson St', lat: 33.71306, lon: -116.21643, kind: 'home' });
  places.add({ name: 'Office', lat: 33.74, lon: -116.25, kind: 'work' });
  places.add({ name: 'Far gym', lat: 33.8, lon: -116.4 });
  places.add({ name: 'Near taco stand', lat: 33.721, lon: -116.216 });
  recents.add({ name: 'Indio Fashion Mall', lat: 33.725, lon: -116.235 });
  recents.add({ name: 'Home again', lat: 33.71307, lon: -116.21644 }); // a saved place
  return { places, recents };
}

test('before typing ("@saved"): HOME, WORK, saved nearest first, then recents', async () => {
  const { places, recents } = savedSetup();
  const list = savedShortlist({ places, recents, near: HERE });
  assert.deepEqual(
    list.map((p) => `${p.kind}:${p.name}`),
    [
      'home:Home',
      'work:Work',
      'saved:Near taco stand',
      'saved:Far gym',
      'recent:Indio Fashion Mall',
    ],
  );
  assert.equal(list[0].detail, '46211 Jackson St');
  assert.equal(list[0].id, `saved:${places.role('home').id}`);
  // The car asks the same through the search channel (shell-car search()).
  const viaSearch = await searchDestinations(null, SAVED_QUERY, {
    near: HERE,
    places,
    recents,
  });
  assert.deepEqual(viaSearch, list);
  assert.deepEqual(savedShortlist({}), []);
});

test('typing: the saved places that match come first; "home" finds HOME', async () => {
  const { places } = savedSetup();
  const client = {
    getJson: async (feed) => {
      if (feed === 'photon') return fixture('photon-46211-jackson-indio.json');
      throw new Error(`unexpected ${feed}`);
    },
  };
  const out = await searchDestinations(client, 'taco', { near: HERE, places });
  assert.equal(out[0].name, 'Near taco stand');
  assert.equal(out[0].kind, 'saved');
  const home = await searchDestinations(null, 'home', { near: HERE, places });
  assert.equal(home[0].kind, 'home');
  assert.deepEqual(savedPlace(places.role('work')).name, 'Work');
});

test('"Highway 111 and Golf Center pkway" near Indio: the crossing first, in Indio', async () => {
  resetReverseMemo();
  const asked = [];
  const client = {
    getJson: async (feed, path, opts) => {
      asked.push({ feed, params: opts?.params });
      if (feed === 'photon') return { type: 'FeatureCollection', features: [] };
      if (feed === 'photon-reverse') return reverseFixture;
      throw new Error(`unexpected ${feed}`);
    },
  };
  const roads = async () => roadsFixture.lines;
  const out = await searchDestinations(client, 'Highway 111 and Golf Center pkway', {
    near: HERE,
    roads,
  });
  assert.equal(out[0].name, 'Highway 111 & Golf Center Parkway');
  assert.equal(out[0].detail, 'Indio, California');
  assert.equal(out[0].kind, 'intersection');
  assert.equal(near(out[0], { lat: 33.7149, lon: -116.2103 }, 0.05), true);
  for (const p of out) assert.deepEqual(Object.keys(p).sort(), PLACE_KEYS);
  // The town of the crossing: one precise reverse question (four decimals).
  const rev = asked.find((a) => a.feed === 'photon-reverse');
  assert.equal(rev.params.lat, '33.7149');
  // No user position: no crossing search (it is local by nature).
  const far = await searchDestinations(client, 'Highway 111 and Golf Center pkway', {
    roads,
  });
  assert.equal(far.length, 0);
});

test('"and" in a name: places that match stay first, crossings follow', async () => {
  resetReverseMemo();
  // Two made-up streets crossing near the user, and a shop named after them.
  const lines = [
    {
      names: ['Lord Street'],
      coords: [
        [33.72, -116.22],
        [33.72, -116.21],
      ],
    },
    {
      names: ['Taylor Street'],
      coords: [
        [33.715, -116.215],
        [33.725, -116.215],
      ],
    },
  ];
  const shop = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-116.3, 33.8] },
        properties: {
          name: 'Lord and Taylor',
          osm_key: 'shop',
          osm_value: 'department_store',
          countrycode: 'US',
        },
      },
    ],
  };
  const client = (photon) => ({
    getJson: async (feed) => {
      if (feed === 'photon') return photon;
      if (feed === 'photon-reverse') return { features: [] };
      throw new Error(`unexpected ${feed}`);
    },
  });
  const roads = async () => lines;
  const withShop = await searchDestinations(client(shop), 'Lord and Taylor', {
    near: HERE,
    roads,
  });
  assert.deepEqual(
    withShop.map((p) => p.name),
    ['Lord and Taylor', 'Lord Street & Taylor Street'],
  );
  // Nothing that matches well: the crossing leads ("Monroe and Avenue 44").
  const noShop = await searchDestinations(
    client({ type: 'FeatureCollection', features: [] }),
    'Lord and Taylor',
    { near: HERE, roads },
  );
  assert.equal(noShop[0].name, 'Lord Street & Taylor Street');
});

test('a found crossing does not wait for a place search that hangs', async () => {
  resetReverseMemo();
  const client = {
    getJson: (feed) =>
      feed === 'photon-reverse' ? Promise.resolve(reverseFixture) : new Promise(() => {}), // Photon down
  };
  const t0 = Date.now();
  const out = await searchDestinations(client, 'Jackson St & Indio Blvd', {
    near: HERE,
    roads: async () => roadsFixture.lines,
  });
  assert.ok(Date.now() - t0 < 4000);
  assert.equal(out[0].name, 'Jackson Street & Indio Boulevard');
  assert.equal(near(out[0], { lat: 33.7206, lon: -116.2162 }, 0.05), true);
});
