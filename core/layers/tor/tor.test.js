import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOnionoo,
  relayRole,
  countryCentroid,
  onionooQuery,
  ONIONOO_FIELDS,
} from './parse.js';
import {
  describeTor,
  formatBandwidth,
  torColorHex,
  torNote,
  torSearchText,
} from './format.js';
import { demoOnionoo } from './mockSource.js';
import { INK } from '../../ui/palette.js';

const FP = (c) => c.repeat(40);

test('roles from flags', () => {
  assert.equal(relayRole(['Exit', 'Guard', 'Running']), 'exit');
  assert.equal(relayRole(['Exit', 'BadExit', 'Guard']), 'guard');
  assert.equal(relayRole(['Guard']), 'guard');
  assert.equal(relayRole(['Fast', 'Running']), 'middle');
  assert.equal(relayRole(null), 'middle');
});

test('the query asks only public relay fields, never the operator contact', () => {
  const q = onionooQuery();
  assert.equal(q.type, 'relay');
  assert.equal(q.running, 'true');
  assert.equal(q.fields, ONIONOO_FIELDS);
  assert.equal(ONIONOO_FIELDS.includes('contact'), false);
});

test('relays are placed by coordinates, else near their country centroid', () => {
  const list = parseOnionoo({
    relays_published: '2026-10-08 12:00:00',
    relays: [
      {
        nickname: 'withCoords',
        fingerprint: FP('A'),
        country: 'de',
        flags: ['Exit'],
        latitude: 50.1,
        longitude: 8.7,
        observed_bandwidth: 12_345_678,
      },
      { nickname: 'deOne', fingerprint: FP('B'), country: 'de', flags: ['Guard'] },
      { nickname: 'deTwo', fingerprint: FP('C'), country: 'de', flags: [] },
      { nickname: 'nowhere', fingerprint: FP('D'), country: 'zz', flags: [] },
      { nickname: 'noCountry', fingerprint: FP('E'), flags: [] },
      { nickname: 'bad', fingerprint: 'xyz', country: 'de' },
      { nickname: 'dupe', fingerprint: FP('a'), country: 'de' },
    ],
  });
  assert.equal(list.length, 3);
  assert.equal(list.unplaced, 2);
  assert.equal(list.published, '2026-10-08 12:00:00');
  const [coords, one, two] = list;
  assert.equal(coords.id, `tor/${FP('A')}`);
  assert.equal(coords.meta.placed, 'coordinates');
  assert.equal(coords.position.latitude, 50.1);
  assert.equal(coords.meta.role, 'exit');
  const [clat, clon] = countryCentroid('DE');
  assert.equal(one.meta.placed, 'country');
  assert.equal(one.position.latitude, clat, 'the first sits on the centroid');
  assert.equal(one.position.longitude, clon);
  assert.notDeepEqual(two.position, one.position, 'the next spirals out');
  assert.ok(Math.abs(two.position.latitude - clat) < 3.5);
  assert.equal(parseOnionoo(null).length, 0);
});

test('the spiral is stable and stays near the country', () => {
  const a = parseOnionoo(demoOnionoo(400));
  const b = parseOnionoo(demoOnionoo(400));
  assert.equal(a.length, 400);
  assert.deepEqual(
    a.map((n) => [n.id, n.position.latitude, n.position.longitude]),
    b.map((n) => [n.id, n.position.latitude, n.position.longitude]),
  );
  for (const n of a) {
    const [clat] = countryCentroid(n.meta.country);
    assert.ok(Math.abs(n.position.latitude - clat) <= 3.01, n.id);
  }
  assert.ok(a.every((n) => n.meta.demo));
});

test('cards, colours and search', () => {
  const [exit] = parseOnionoo({
    relays: [
      {
        nickname: 'exitOne',
        fingerprint: FP('F'),
        country: 'nl',
        country_name: 'Netherlands',
        as: 'AS1101',
        as_name: 'Example Net',
        flags: ['Exit', 'Fast'],
        observed_bandwidth: 12_345_678,
      },
    ],
  });
  const card = describeTor(exit);
  assert.equal(card.title, 'exitOne');
  const rows = Object.fromEntries(card.rows);
  assert.equal(rows.Role, 'Exit relay');
  assert.equal(rows.Bandwidth, '12.3 MB/s');
  assert.equal(rows.Network, 'AS1101 Example Net');
  assert.equal(rows.Country, 'Netherlands');
  assert.match(rows.Placement, /centroid/);
  assert.equal(
    card.links[0].url,
    `https://metrics.torproject.org/rs.html#details/${FP('F')}`,
  );
  assert.equal(torColorHex(exit), INK.white);
  assert.match(torSearchText(exit), /exitOne/);
  assert.equal(formatBandwidth(950), '950 B/s');
  assert.equal(formatBandwidth(1500), '1.5 KB/s');
  assert.equal(formatBandwidth(250_000_000), '250 MB/s');
  assert.equal(formatBandwidth(0), null);
  assert.equal(torNote(Object.assign([], { unplaced: 3 })), '3 without a mapped country');
  assert.equal(torNote([]), '');
});
