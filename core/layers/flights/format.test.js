import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAircraft,
  formatAltitude,
  formatSpeed,
  formatVerticalRate,
  formatHeading,
} from './format.js';

test('unit conversions', () => {
  assert.equal(formatAltitude(1000), '3,281 ft');
  assert.equal(formatSpeed(100), '194 kt');
  assert.equal(formatVerticalRate(5), '+984 ft/min');
  assert.equal(formatVerticalRate(-5), '-984 ft/min');
  assert.equal(formatHeading(89.6), '90°');
});

test('null-safe formatting', () => {
  assert.equal(formatAltitude(null), '—');
  assert.equal(formatSpeed(undefined), '—');
  assert.equal(formatVerticalRate(NaN), '—');
  assert.equal(formatHeading(null), '—');
});

test('formatAircraft builds a card model', () => {
  const card = formatAircraft({
    id: 'abc123',
    callsign: 'DLH123',
    originCountry: 'Germany',
    onGround: false,
    geoAltitude: 11000,
    baroAltitude: 10980,
    velocity: 250,
    trueTrack: 270,
    verticalRate: 0,
  });
  assert.equal(card.id, 'abc123');
  assert.equal(card.title, 'DLH123');
  assert.equal(card.subtitle, 'Germany');
  const map = Object.fromEntries(card.rows);
  assert.equal(map.ICAO24, 'abc123');
  assert.equal(map.Status, 'airborne');
  assert.equal(map.Heading, '270°');
  assert.equal(map.Altitude, formatAltitude(11000)); // prefers geo over baro
});

test('formatAircraft falls back to id when callsign is blank', () => {
  const card = formatAircraft({ id: 'xyz', callsign: '  ', onGround: true });
  assert.equal(card.title, 'xyz');
});

test('formatAircraft adds adsb.lol extras and the source when present', () => {
  const card = formatAircraft({
    id: 'a1b2c3',
    callsign: 'UAL123',
    registration: 'N12345',
    typeCode: 'B738',
    squawk: '1200',
    source: 'adsb.lol',
  });
  const map = Object.fromEntries(card.rows);
  assert.equal(card.subtitle, 'B738 · N12345');
  assert.equal(map.Registration, 'N12345');
  assert.equal(map.Type, 'B738');
  assert.equal(map.Squawk, '1200');
  assert.equal(map.Source, 'adsb.lol');
});
