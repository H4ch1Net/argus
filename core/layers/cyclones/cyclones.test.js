import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCyclones } from './parse.js';
import { describeCyclone, saffirSimpson, cycloneColorHex } from './format.js';

const storm = {
  id: 'al052026',
  name: 'Example',
  classification: 'HU',
  intensity: '100',
  pressure: '955',
  latitudeNumeric: 25.1,
  longitudeNumeric: -75.3,
  movementDir: 315,
  movementSpeed: 12,
  lastUpdate: '2026-09-10T15:00:00.000Z',
  forecastAdvisory: {
    advNum: '021',
    url: 'https://www.nhc.noaa.gov/text/MIATCMAT5.shtml',
  },
};

test('parses active storms with numbers from strings', () => {
  const [s] = parseCyclones({ activeStorms: [storm] });
  assert.equal(s.id, 'nhc:al052026');
  assert.deepEqual(s.position, { longitude: -75.3, latitude: 25.1, altitude: 0 });
  assert.equal(s.meta.windKt, 100);
  assert.equal(s.meta.pressureHpa, 955);
  assert.equal(s.meta.basin, 'Atlantic');
  assert.equal(s.meta.advisoryUrl, 'https://www.nhc.noaa.gov/text/MIATCMAT5.shtml');
});

test('drops malformed ids, positions, and off-site advisory links', () => {
  const out = parseCyclones({
    activeStorms: [
      { ...storm, id: 'xx123' },
      { ...storm, id: 'ep012026', latitudeNumeric: null },
      { ...storm, id: 'cp012026', forecastAdvisory: { url: 'https://evil.example/x' } },
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].meta.advisoryUrl, null);
  assert.deepEqual(parseCyclones(null), []);
});

test('Saffir-Simpson categories and the card', () => {
  assert.equal(saffirSimpson(63), null);
  assert.equal(saffirSimpson(64), 1);
  assert.equal(saffirSimpson(100), 3);
  assert.equal(saffirSimpson(140), 5);
  assert.match(cycloneColorHex(40), /^#/);
  const card = describeCyclone(parseCyclones({ activeStorms: [storm] })[0]);
  assert.equal(card.title, 'Example');
  assert.deepEqual(card.rows[0], ['Class', 'Hurricane, category 3']);
  assert.deepEqual(card.rows[3], ['Moving', '315° at 12 kt']);
  assert.equal(card.links[0].url, storm.forecastAdvisory.url);
});
