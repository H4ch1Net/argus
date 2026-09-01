import { test } from 'node:test';
import assert from 'node:assert/strict';
import { magnitudeColorHex, magnitudePixelSize, describeQuake } from './format.js';

test('magnitude color ramps by severity', () => {
  assert.equal(magnitudeColorHex(1), '#39d98a');
  assert.equal(magnitudeColorHex(4.5), '#e3a857');
  assert.equal(magnitudeColorHex(7), '#ff3b30');
  assert.equal(magnitudeColorHex(null), '#9aa7b8');
});

test('magnitude size is bounded and increasing', () => {
  assert.equal(magnitudePixelSize(null), 6);
  assert.ok(magnitudePixelSize(6) > magnitudePixelSize(3));
  assert.ok(magnitudePixelSize(9) <= 40); // capped
  assert.ok(magnitudePixelSize(1) >= 5); // floored
});

test('describeQuake builds a card model', () => {
  const card = describeQuake({
    id: 'us1',
    position: { longitude: -120.5, latitude: 38.2, altitude: 0 },
    meta: { mag: 5.2, place: 'Somewhere', time: 0, depthKm: 12.3 },
  });
  assert.equal(card.title, 'M 5.2');
  assert.equal(card.subtitle, 'Somewhere');
  const map = Object.fromEntries(card.rows);
  assert.equal(map.Magnitude, '5.2');
  assert.equal(map.Depth, '12 km');
  assert.equal(map.Coordinates, '38.20, -120.50');
});
