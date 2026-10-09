import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GDELT_FEED,
  GDELT_EVENTS_PATH,
  GDELT_THEMES,
  articleTitle,
  cameoLabel,
  gdeltStatusNote,
  parseGdeltEvents,
} from './parse.js';
import {
  describeGdelt,
  gdeltColorHex,
  gdeltPixelSize,
  gdeltSearchText,
} from './format.js';
import { createGdeltSource, createGdeltMockSource } from './source.js';
import { INK } from '../../ui/palette.js';

// The proxy's document shape (proxy/lib/gdelt.js), values from the real
// 2026-10-09 06:00 UTC export.
const DOC = {
  v: 1,
  source: 'GDELT 2.0 Events',
  updated: '2026-10-09T06:00:00Z',
  windowMinutes: 60,
  exports: 4,
  events: [
    {
      theme: 'conflict',
      code: '190',
      quad: 4,
      goldstein: -10,
      mentions: 10,
      sources: 1,
      articles: 10,
      tone: -9.27,
      geo: 4,
      place: 'Canberra, Australian Capital Territory, Australia',
      cc: 'AS',
      lat: -35.2833,
      lon: 149.217,
      added: '2026-10-09T06:00:00Z',
      n: 3,
      urls: [
        'https://www.abc.net.au/news/2026-10-09/act-man-accused-refused-bail/107246802',
        'javascript:alert(1)',
        'https://www.abc.net.au/news/2026-10-09/act-man-accused-refused-bail/107246802',
      ],
    },
    {
      theme: 'unrest',
      code: '1411',
      quad: 3,
      goldstein: -6.5,
      mentions: 2,
      geo: 1,
      place: 'Malaysia <b>x</b>',
      cc: 'MY',
      lat: 2.5,
      lon: 112.5,
      added: null,
      urls: [],
    },
    { theme: 'aid', code: '073', lat: 95, lon: 0 },
    { theme: 'weather', code: '190', lat: 1, lon: 1 },
    { theme: 'aid', code: '07x', lat: 1, lon: 1 },
    { theme: 'aid', code: '0333', lat: 14.6, lon: 120.98, mentions: 4, tone: 2 },
  ],
};

test('one feed, one path, no query; three themes', () => {
  assert.equal(GDELT_FEED, 'gdelt-events');
  assert.equal(GDELT_EVENTS_PATH, '/events.json');
  assert.deepEqual(
    GDELT_THEMES.map((t) => t.id),
    ['aid', 'unrest', 'conflict'],
  );
});

test('the events document parses into points; bad rows and links are dropped', () => {
  const list = parseGdeltEvents(DOC);
  assert.deepEqual(
    list.map((n) => n.id),
    [
      'gdelt/190/-35.283,149.217',
      'gdelt/1411/2.500,112.500',
      'gdelt/0333/14.600,120.980',
    ],
  );
  const [fight, demo, aid] = list;
  assert.equal(fight.meta.themeLabel, 'Armed conflict / violence');
  assert.equal(fight.meta.codeLabel, 'Conventional military force');
  assert.equal(fight.meta.count, 10);
  assert.equal(fight.meta.events, 3);
  assert.equal(fight.meta.precision, 'city');
  assert.equal(fight.meta.addedMs, Date.parse('2026-10-09T06:00:00Z'));
  assert.equal(fight.meta.articles.length, 1, 'javascript: and the repeat are dropped');
  assert.equal(fight.meta.articles[0].domain, 'abc.net.au');
  assert.equal(fight.meta.headline, 'Act man accused refused bail');
  assert.equal(demo.meta.place, 'Malaysia x', 'tags stripped, never rendered');
  assert.equal(demo.meta.codeLabel, 'Demonstrate for leadership change');
  assert.equal(demo.meta.precision, 'country');
  assert.equal(demo.meta.addedMs, null);
  assert.equal(aid.meta.theme, 'aid');
  assert.equal(aid.meta.goldstein, null);
  assert.equal(parseGdeltEvents(JSON.stringify(DOC)).length, 3);
  assert.deepEqual(parseGdeltEvents('Not Found'), []);
  assert.deepEqual(parseGdeltEvents(null), []);
  assert.deepEqual(parseGdeltEvents({ events: 'x' }), []);
});

test('CAMEO labels and article titles', () => {
  assert.equal(cameoLabel('145'), 'Violent protest, riot');
  assert.equal(cameoLabel('1953'), 'Aerial weapons', 'falls back to its base');
  assert.equal(cameoLabel('209'), 'Unconventional mass violence', 'then its root');
  assert.equal(cameoLabel('0233'), 'Appeal for humanitarian aid');
  assert.equal(
    articleTitle('https://www.example.com/world/2026/10/09/floods-hit-valencia.html'),
    'Floods hit valencia',
  );
  assert.equal(
    articleTitle('https://bdnews24.com/bangladesh/0jajn110q4'),
    'bdnews24.com',
  );
  assert.equal(articleTitle('not a url'), '');
});

test('card, colour, size, note', () => {
  const [fight, , aid] = parseGdeltEvents(DOC);
  const card = describeGdelt(fight, Date.parse('2026-10-09T07:00:00Z'));
  assert.equal(card.title, 'Conventional military force');
  assert.equal(card.subtitle, 'Canberra, Australian Capital Territory, Australia');
  const rows = Object.fromEntries(card.rows);
  assert.equal(rows.Theme, 'Armed conflict / violence');
  assert.equal(rows.Event, 'Conventional military force (CAMEO 190)');
  assert.equal(rows.Reports, '10 mentions, 3 events');
  assert.equal(rows.Tone, '-9.3');
  assert.equal(rows.Goldstein, '-10.0');
  assert.equal(rows.Added, '2026-10-09 06:00 UTC (1h ago)');
  assert.equal(card.links.length, 1);
  assert.ok(card.links.every((l) => /^https?:/.test(l.url)));
  assert.equal(gdeltColorHex(fight), INK.error);
  assert.equal(gdeltColorHex(aid), INK.white);
  assert.ok(gdeltPixelSize(fight) > 9 && gdeltPixelSize(fight) <= 15);
  assert.match(gdeltSearchText(fight), /Canberra/);
  assert.equal(gdeltStatusNote(DOC), 'GDELT 06:00Z, 1 h');
  assert.equal(
    gdeltStatusNote({ updated: '2026-10-09T06:15:00Z', windowMinutes: 30 }),
    'GDELT 06:15Z',
  );
  assert.equal(gdeltStatusNote('x'), '');
  const text = JSON.stringify(card);
  const emDash = String.fromCharCode(0x2014);
  assert.equal(text.includes(emDash), false, 'no em dash placeholders');
});

test('the source makes one plain request; the mock has the same shape', async () => {
  const asked = [];
  const proxyClient = {
    getJson: async (id, path, opts) => {
      asked.push([id, path, opts.params]);
      return DOC;
    },
  };
  const out = await createGdeltSource({ proxyClient })({}, undefined);
  assert.equal(out, DOC);
  assert.deepEqual(asked, [['gdelt-events', '/events.json', undefined]]);
  const mock = parseGdeltEvents(await createGdeltMockSource()());
  assert.equal(mock.length, 15);
  assert.ok(mock.every((n) => n.meta.demo));
  assert.deepEqual([...new Set(mock.map((n) => n.meta.theme))].sort(), [
    'aid',
    'conflict',
    'unrest',
  ]);
});
