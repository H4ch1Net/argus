import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTle } from './tle.js';

const ISS = `ISS (ZARYA)
1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`;

test('parses 3-line TLE with name', () => {
  const sats = parseTle(ISS);
  assert.equal(sats.length, 1);
  assert.equal(sats[0].name, 'ISS (ZARYA)');
  assert.ok(sats[0].line1.startsWith('1 25544'));
  assert.ok(sats[0].line2.startsWith('2 25544'));
});

test('parses multiple records and tolerates blank lines', () => {
  const sats = parseTle(`${ISS}\n\n${ISS}`);
  assert.equal(sats.length, 2);
});

test('parses 2-line form without a name', () => {
  const twoLine = ISS.split('\n').slice(1).join('\n');
  const sats = parseTle(twoLine);
  assert.equal(sats.length, 1);
  assert.match(sats[0].name, /25544/);
});

test('empty input yields no satellites', () => {
  assert.deepEqual(parseTle(''), []);
  assert.deepEqual(parseTle(null), []);
});
