import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeShip } from './format.js';

test('describeShip builds a card model', () => {
  const card = describeShip({
    id: '366123456',
    position: { longitude: -80.19, latitude: 25.76, altitude: 0 },
    meta: { mmsi: 366123456, name: 'EXAMPLE VESSEL', sog: 12.4, cog: 86.7, heading: 87 },
  });
  assert.equal(card.title, 'EXAMPLE VESSEL');
  const map = Object.fromEntries(card.rows);
  assert.equal(map.Speed, '12.4 kn');
  assert.equal(map.Course, '87°');
  assert.equal(map.Heading, '87°');
});

test('heading 511 (not available) and missing name are handled', () => {
  const card = describeShip({
    id: '1',
    position: { longitude: 0, latitude: 0, altitude: 0 },
    meta: { mmsi: 1, name: '', sog: null, cog: null, heading: 511 },
  });
  assert.equal(card.title, 'MMSI 1');
  const map = Object.fromEntries(card.rows);
  assert.equal(map.Heading, '—');
  assert.equal(map.Speed, '—');
});
