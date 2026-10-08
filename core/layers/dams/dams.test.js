import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOverpass } from '../overpass/parse.js';
import { buildBBoxQuery } from '../overpass/client.js';
import { DAM_FILTERS, describeDam, damSearchText } from './format.js';

const bbox = { lamin: 36, lomin: -115, lamax: 37, lomax: -114 };

test('the Overpass query asks for named dams and man_made dams with centres', () => {
  const q = buildBBoxQuery(DAM_FILTERS, bbox);
  assert.match(q, /nwr\["waterway"="dam"\]\["name"\]\(36,-115,37,-114\);/);
  assert.match(q, /nwr\["man_made"="dam"\]\(36,-115,37,-114\);/);
  assert.match(q, /out center/);
});

test('dam card with height, build year and source links', () => {
  const [n] = parseOverpass({
    elements: [
      {
        type: 'way',
        id: 77,
        center: { lat: 36.0161, lon: -114.7377 },
        tags: {
          waterway: 'dam',
          name: 'Hoover Dam',
          operator: 'Bureau of Reclamation',
          height: '221',
          start_date: '1931',
          wikipedia: 'en:Hoover Dam',
          wikidata: 'Q134883',
          'ref:nid': 'NV00001',
        },
      },
    ],
  });
  const card = describeDam(n);
  assert.equal(card.title, 'Hoover Dam');
  assert.equal(card.subtitle, 'Bureau of Reclamation');
  const row = (k) => card.rows.find((r) => r[0] === k)?.[1];
  assert.equal(row('Height'), '221 m');
  assert.equal(row('Built'), '1931');
  assert.equal(row('NID'), 'NV00001');
  assert.deepEqual(
    card.links.map((l) => l.url),
    [
      'https://www.openstreetmap.org/way/77',
      'https://en.wikipedia.org/wiki/Hoover_Dam',
      'https://www.wikidata.org/wiki/Q134883',
    ],
  );
  assert.match(damSearchText(n), /hoover dam/i);
});

test('unnamed dams and odd tags degrade quietly', () => {
  const [n] = parseOverpass({
    elements: [
      {
        type: 'node',
        id: 1,
        lat: 1,
        lon: 2,
        tags: {
          man_made: 'dam',
          height: "30'",
          wikipedia: 'javascript:x',
          wikidata: 'Q1; drop',
        },
      },
    ],
  });
  const card = describeDam(n);
  assert.equal(card.title, 'Dam');
  assert.equal(card.rows.find((r) => r[0] === 'Height')[1], "30'");
  assert.deepEqual(
    card.links.map((l) => l.label),
    ['View on OpenStreetMap'],
  );
});
