import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearch } from './search.js';

const manager = { activeLayers: () => [] };
const camera = { flyTo: () => {} };

test('with no geocoder, bundled places still answer', async () => {
  const s = createSearch({ manager, camera, onSelectEntity: () => {} });
  const places = (await s.search('paris')).filter((r) => r.kind === 'place');
  assert.deepEqual(places[0], {
    kind: 'place',
    label: 'Paris, France',
    sub: 'place',
    longitude: 2.35,
    latitude: 48.86,
  });
  // A 2-letter query answers only when it is an exact alias.
  assert.equal((await s.search('LA'))[0].label, 'Los Angeles, United States');
  assert.deepEqual(await s.search('ca'), []);
});

test('3+ characters go through the geocoder chain when there is one', async () => {
  const asked = [];
  const geocode = async (q) => {
    asked.push(q);
    return [{ name: 'Paris, Texas', longitude: -95.55, latitude: 33.66 }];
  };
  const s = createSearch({ manager, camera, geocode, onSelectEntity: () => {} });
  assert.equal((await s.search('Paris, TX'))[0].label, 'Paris, Texas');
  assert.deepEqual(asked, ['Paris, TX']);
  await s.search('LA');
  assert.deepEqual(asked, ['Paris, TX'], 'a 2-letter alias never reaches the network');
});

test('landmarks answer offline and fly to their own view', async () => {
  const flown = [];
  const cam = { flyTo: () => {}, flyAround: (v) => flown.push(v) };
  const s = createSearch({ manager, camera: cam, onSelectEntity: () => {} });
  const hit = (await s.search('eiffel')).find((r) => r.sub === 'landmark');
  assert.ok(hit, 'a landmark result');
  assert.match(hit.label, /eiffel/i);
  await s.select(hit);
  assert.equal(flown.length, 1);
  assert.ok(flown[0].range > 0);
});

test('saved places answer search and fly to their saved camera', async () => {
  const views = [];
  const cam = { flyTo: () => {}, flyToView: (v) => views.push(v) };
  const savedPlaces = {
    search: (q) =>
      q === 'base'
        ? [
            {
              name: 'Base',
              lat: 1,
              lon: 2,
              view: { lat: 1, lon: 2, alt: 900, heading: 10, pitch: -40 },
            },
          ]
        : [],
  };
  const s = createSearch({ manager, camera: cam, onSelectEntity: () => {}, savedPlaces });
  const hit = (await s.search('base')).find((r) => r.sub === 'saved');
  assert.ok(hit);
  await s.select(hit);
  assert.equal(views[0].height, 900);
});
