import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GDELT_THEMES,
  gdeltQuery,
  gdeltArticles,
  parseGdeltGeo,
  parseGdeltThemes,
} from './parse.js';
import {
  describeGdelt,
  gdeltColorHex,
  gdeltPixelSize,
  gdeltSearchText,
} from './format.js';
import { createGdeltSource, createGdeltMockSource } from './source.js';
import { INK } from '../../ui/palette.js';

const [disaster] = GDELT_THEMES;

const ANSWER = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [120.98, 14.6] },
      properties: {
        name: 'Manila, Manila, Philippines',
        count: 42,
        shareimage: 'https://example.org/i.jpg',
        html: '<a href="https://news.example.com/a?x=1&amp;y=2" title="Typhoon nears &quot;Luzon&quot;">Typhoon</a><BR><a href="javascript:alert(1)" title="bad">bad</a><a href="https://other.example.org/b">Floods <b>rise</b></a>',
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [500, 0] },
      properties: {},
    },
    { type: 'Feature', geometry: null, properties: {} },
  ],
};

test('fixed theme queries only, pinned in shape', () => {
  assert.deepEqual(
    GDELT_THEMES.map((t) => t.id),
    ['disaster', 'unrest', 'conflict'],
  );
  for (const t of GDELT_THEMES) {
    assert.match(t.query, /^theme:[A-Z_]+$/);
    assert.deepEqual(gdeltQuery(t), {
      query: t.query,
      mode: 'PointData',
      format: 'GeoJSON',
    });
  }
});

test('article links: http(s) only, entities decoded, tags stripped', () => {
  const a = gdeltArticles(ANSWER.features[0].properties.html);
  assert.equal(a.length, 2);
  assert.equal(a[0].url, 'https://news.example.com/a?x=1&y=2');
  assert.equal(a[0].title, 'Typhoon nears "Luzon"');
  assert.equal(a[0].domain, 'news.example.com');
  assert.equal(a[1].title, 'Floods rise');
  assert.equal(gdeltArticles(null).length, 0);
});

test('a GEO answer parses into event points; text errors parse as none', () => {
  const list = parseGdeltGeo(ANSWER, disaster);
  assert.equal(list.length, 1);
  const [e] = list;
  assert.equal(e.id, 'gdelt/disaster/120.980,14.600');
  assert.equal(e.meta.count, 42);
  assert.equal(e.meta.place, 'Manila, Manila, Philippines');
  assert.equal(e.meta.headline, 'Typhoon nears "Luzon"');
  assert.deepEqual(parseGdeltGeo(JSON.stringify(ANSWER), disaster).length, 1);
  assert.deepEqual(parseGdeltGeo('Invalid query', disaster), []);
  // Several themes: one point per place and theme.
  const all = parseGdeltThemes({ disaster: ANSWER, conflict: ANSWER, nope: ANSWER });
  assert.deepEqual(
    all.map((n) => n.meta.theme),
    ['disaster', 'conflict'],
  );
});

test('card, colour and size', () => {
  const [e] = parseGdeltGeo(ANSWER, GDELT_THEMES[2]);
  const card = describeGdelt(e);
  assert.equal(card.title, 'Typhoon nears "Luzon"');
  assert.equal(card.links.length, 2);
  assert.equal(Object.fromEntries(card.rows).Theme, 'Armed conflict');
  assert.equal(gdeltColorHex(e), INK.error);
  assert.ok(gdeltPixelSize(e) > 9 && gdeltPixelSize(e) <= 15);
  assert.match(gdeltSearchText(e), /Manila/);
});

test('the source asks each theme in turn, spaced, and survives one failure', async () => {
  const asked = [];
  const proxyClient = {
    getText: async (id, path, opts) => {
      asked.push([id, path, opts.params.query]);
      if (opts.params.query === 'theme:PROTEST') throw new Error('502');
      return JSON.stringify(ANSWER);
    },
  };
  const out = await createGdeltSource({ proxyClient, gapMs: 1 })({});
  assert.deepEqual(
    asked.map((a) => a[2]),
    GDELT_THEMES.map((t) => t.query),
  );
  assert.ok(asked.every(([id, path]) => id === 'gdelt-geo' && path === '/geo'));
  assert.deepEqual(Object.keys(out), ['disaster', 'conflict']);
  const dead = createGdeltSource({
    proxyClient: { getText: async () => Promise.reject(new Error('x')) },
    gapMs: 1,
  });
  await assert.rejects(dead({}), /no theme answered/);
  const ac = new AbortController();
  const slow = createGdeltSource({ proxyClient, gapMs: 10_000 })({}, ac.signal);
  ac.abort();
  await assert.rejects(slow, { name: 'AbortError' });
  const mock = parseGdeltThemes(await createGdeltMockSource()());
  assert.equal(mock.length, 15);
  assert.ok(mock.every((n) => n.meta.demo));
});
