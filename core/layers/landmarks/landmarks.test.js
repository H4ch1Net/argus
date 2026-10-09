import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  landmarksQuery,
  parseLandmarks,
  landmarkCategory,
  isLandmark,
  rankLandmarks,
  landmarkFraming,
  distanceKm,
  bearingDeg,
  createLandmarksLoader,
} from './parse.js';
import { describeLandmark, wikipediaLink, categoryLabel } from './format.js';
import { loadAround } from '../overpass/tiles.js';
import { PARIS_LANDMARKS } from './fixtures.js';

test('the query: named attractions, history, towers; no small memorials; tags and centres only', () => {
  const ql = landmarksQuery({ lamin: 48.8, lomin: 2.3, lamax: 48.9, lomax: 2.4 });
  assert.match(
    ql,
    /nwr\["tourism"~"\^\(attraction\|museum\|viewpoint\|zoo\|theme_park\|aquarium\)\$"\]\["name"\]\(48\.8,2\.3,48\.9,2\.4\);/,
  );
  assert.match(ql, /\["memorial"!~"\^\(plaque\|/);
  assert.match(ql, /nwr\["man_made"~"\^\(tower\|lighthouse\)\$"\]\["name"\]/);
  assert.match(ql, /out tags center \d+;$/);
});

test('real Paris landmarks: plaques and galleries dropped, Wikipedia-linked ones flagged', () => {
  const list = parseLandmarks(PARIS_LANDMARKS);
  const names = list.map((n) => n.meta.name);
  assert.ok(!names.includes('Maison natale de Molière'), 'plaques dropped');
  assert.ok(!names.includes('Lelong & Co.'), 'commercial galleries dropped');
  assert.ok(names.includes('Tour Eiffel') && names.includes('Musée en Herbe'));
  const eiffel = list.find((n) => n.meta.name === 'Tour Eiffel');
  assert.equal(eiffel.id, 'way/5013364');
  assert.equal(eiffel.meta.category, 'tower');
  assert.equal(eiffel.meta.notable, true);
  assert.equal(list.find((n) => n.meta.name === 'Musée en Herbe').meta.notable, false);
  assert.equal(landmarkCategory({ historic: 'castle', tourism: 'museum' }), 'museum');
  assert.equal(landmarkCategory({ man_made: 'lighthouse' }), 'lighthouse');
  assert.equal(
    isLandmark({ name: 'X', man_made: 'tower', 'tower:type': 'communication' }),
    true,
  );
  // An anonymous communication mast is not a landmark; a famous one is.
  assert.deepEqual(
    parseLandmarks({
      elements: [
        {
          type: 'node',
          id: 1,
          lat: 0,
          lon: 0,
          tags: { name: 'Mast 7', man_made: 'tower', 'tower:type': 'communication' },
        },
        {
          type: 'node',
          id: 2,
          lat: 0,
          lon: 0,
          tags: {
            name: 'Sutro Tower',
            man_made: 'tower',
            'tower:type': 'communication',
            wikidata: 'Q1',
          },
        },
      ],
    }).map((n) => n.id),
    ['node/2'],
  );
  const card = describeLandmark(eiffel);
  assert.equal(card.title, 'Tour Eiffel');
  assert.equal(card.subtitle, 'Tower');
  assert.deepEqual(
    card.rows.find((r) => r[0] === 'English'),
    ['English', 'Eiffel Tower'],
  );
  assert.deepEqual(
    card.rows.find((r) => r[0] === 'Height'),
    ['Height', '330 m'],
  );
  const urls = card.links.map((l) => l.url);
  assert.ok(urls.includes('https://fr.wikipedia.org/wiki/Tour_Eiffel'));
  assert.ok(urls.includes('https://www.wikidata.org/wiki/Q243'));
  assert.ok(urls.includes('https://www.openstreetmap.org/way/5013364'));
  assert.deepEqual(wikipediaLink("fr:Musée de l'Armée (Paris)"), {
    label: 'Wikipedia (fr)',
    url: `https://fr.wikipedia.org/wiki/${encodeURIComponent("Musée_de_l'Armée_(Paris)")}`,
  });
  assert.equal(wikipediaLink('nonsense'), null);
  assert.equal(categoryLabel('archaeological_site'), 'Archaeological site');
});

test('NEARBY: Wikipedia-linked first, then by distance, one per name, within the radius', () => {
  const at = { lat: 48.8584, lon: 2.2945 }; // under the Eiffel Tower
  const list = parseLandmarks(PARIS_LANDMARKS);
  const ranked = rankLandmarks(list, at, { limit: 12, maxKm: 6 });
  assert.equal(ranked[0].n.meta.name, 'Tour Eiffel');
  assert.ok(ranked[0].km < 0.2);
  const firstPlain = ranked.findIndex((r) => !r.n.meta.notable);
  assert.ok(
    firstPlain === -1 || ranked.slice(firstPlain).every((r) => !r.n.meta.notable),
  );
  for (let i = 1; i < ranked.length; i += 1) {
    if (ranked[i].n.meta.notable === ranked[i - 1].n.meta.notable)
      assert.ok(ranked[i].km >= ranked[i - 1].km);
  }
  assert.ok(ranked.every((r) => r.km <= 6));
  // Duplicates by name come once.
  const dup = [...list, { ...list[0], id: 'node/99' }];
  assert.equal(
    rankLandmarks(dup, at, { maxKm: 50 }).filter(
      (r) => r.n.meta.name === list[0].meta.name,
    ).length,
    1,
  );
  assert.deepEqual(rankLandmarks(list, null), []);
});

test('framing: a tower from further out at its middle, heading from where you are', () => {
  const list = parseLandmarks(PARIS_LANDMARKS);
  const eiffel = list.find((n) => n.meta.name === 'Tour Eiffel');
  const from = { lat: 48.85, lon: 2.2945 }; // south of it
  const v = landmarkFraming(eiffel, from);
  assert.equal(v.height, 165);
  assert.equal(v.range, 1650);
  assert.ok(v.pitch < 0 && v.pitch > -30);
  assert.ok(
    Math.abs(v.heading) < 1 || Math.abs(v.heading - 360) < 1,
    'looking north at it',
  );
  const museum = list.find((n) => n.meta.name === 'Musée en Herbe');
  const m = landmarkFraming(museum);
  assert.equal(m.heading, 0);
  assert.equal(m.range, 700);
  assert.ok(Math.abs(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 111.19) < 0.1);
  assert.ok(Math.abs(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 90) < 1e-6);
});

test('the NEARBY list and the layer share one loader: each area once', async () => {
  let asked = 0;
  const loader = createLandmarksLoader({
    proxyClient: null,
    fetchTile: async () => {
      asked += 1;
      return PARIS_LANDMARKS;
    },
  });
  const at = { lat: 48.8584, lon: 2.2945 };
  const a = await loadAround(loader, at, 2);
  const first = asked;
  assert.ok(first >= 1 && first <= 4);
  assert.ok(a.items.length > 0);
  await loadAround(loader, at, 2);
  assert.equal(asked, first, 'held');
});
