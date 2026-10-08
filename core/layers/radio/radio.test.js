import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRadio, radioQuery } from './parse.js';
import { describeRadio, radioColorHex } from './format.js';

const station = (over = {}) => ({
  stationuuid: '96062a7b-0601-11e8-ae97-52543be04c81',
  name: ' Example FM ',
  url: 'http://example.org/stream',
  url_resolved: 'https://example.org/stream.mp3',
  homepage: 'https://example.org/',
  tags: 'news,talk, public radio',
  language: 'english',
  country: 'United States Of America',
  countrycode: 'US',
  state: 'Ohio',
  codec: 'MP3',
  bitrate: 128,
  clickcount: 1234,
  lastcheckok: 1,
  hls: 0,
  geo_lat: 39.96,
  geo_long: -83.0,
  ...over,
});

test('parses stations with coordinates and an https stream', () => {
  const [s] = parseRadio([station()]);
  assert.equal(s.id, 'radio:96062a7b-0601-11e8-ae97-52543be04c81');
  assert.equal(s.meta.name, 'Example FM');
  assert.equal(s.meta.stream, 'https://example.org/stream.mp3');
  assert.deepEqual(s.meta.tags, ['news', 'talk', 'public radio']);
  assert.equal(radioColorHex(s), '#ffcc80');
});

test('drops broken, HLS, insecure, unlocated, duplicate and malformed stations', () => {
  const out = parseRadio([
    station(),
    station(), // duplicate uuid
    station({ stationuuid: 'not-a-uuid' }),
    station({ stationuuid: '00000000-0000-0000-0000-000000000001', lastcheckok: 0 }),
    station({ stationuuid: '00000000-0000-0000-0000-000000000002', hls: 1 }),
    station({
      stationuuid: '00000000-0000-0000-0000-000000000003',
      url_resolved: 'http://x/',
      url: 'http://x/',
    }),
    station({ stationuuid: '00000000-0000-0000-0000-000000000004', geo_lat: null }),
    station({
      stationuuid: '00000000-0000-0000-0000-000000000005',
      geo_lat: 0,
      geo_long: 0,
    }),
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(parseRadio(null), []);
});

test('the card links the stream and says listening is direct', () => {
  const card = describeRadio(parseRadio([station()])[0]);
  assert.equal(card.subtitle, 'Ohio, United States Of America');
  assert.equal(card.links[0].url, 'https://example.org/stream.mp3');
  assert.ok(card.rows.some(([k, v]) => k === 'Note' && /directly/.test(v)));
  const q = radioQuery(10);
  assert.equal(q.has_geo_info, 'true');
  assert.equal(q.limit, 10);
});
