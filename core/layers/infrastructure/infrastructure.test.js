import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOverpass } from '../overpass/parse.js';
import { buildBBoxQuery } from '../overpass/client.js';
import {
  DATACENTER_FILTERS,
  INSTALLATION_FILTERS,
  describeDatacenter,
  describeInstallation,
  installationKind,
} from './format.js';

const bbox = { lamin: 50, lomin: 8, lamax: 51, lomax: 9 };

test('the Overpass queries cover nodes, ways and relations with centres', () => {
  const q = buildBBoxQuery(DATACENTER_FILTERS, bbox);
  assert.match(q, /nwr\["telecom"="data_center"\]\(50,8,51,9\);/);
  assert.match(q, /out center/);
  assert.match(buildBBoxQuery(INSTALLATION_FILTERS, bbox), /nwr\["landuse"="military"\]/);
});

test('data centre card with operator, address and links', () => {
  const [n] = parseOverpass({
    elements: [
      {
        type: 'way',
        id: 42,
        center: { lat: 50.1, lon: 8.6 },
        tags: {
          telecom: 'data_center',
          name: 'FRA1',
          operator: 'Example DC',
          'addr:street': 'Hanauer Landstrasse',
          'addr:housenumber': '1',
          'addr:city': 'Frankfurt',
          website: 'https://dc.example/',
        },
      },
    ],
  });
  const card = describeDatacenter(n);
  assert.equal(card.title, 'FRA1');
  assert.deepEqual(card.rows[1], ['Address', '1 Hanauer Landstrasse, Frankfurt']);
  assert.equal(card.links[0].url, 'https://www.openstreetmap.org/way/42');
  assert.equal(card.links[1].url, 'https://dc.example/');
});

test('installation kinds and cards', () => {
  assert.equal(installationKind({ military: 'naval_base' }), 'naval_base');
  assert.equal(installationKind({ landuse: 'military' }), 'military area');
  const [n] = parseOverpass({
    elements: [{ type: 'node', id: 7, lat: 1, lon: 2, tags: { military: 'naval_base' } }],
  });
  const card = describeInstallation(n);
  assert.equal(card.title, 'naval base');
  assert.equal(card.links[0].url, 'https://www.openstreetmap.org/node/7');
});
