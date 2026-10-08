import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMilitary, militarySearchText } from './parse.js';
import { formatAircraft } from '../flights/format.js';

const payload = {
  now: 1_700_000_000_000,
  ac: [
    {
      hex: 'ae1234',
      flight: 'RCH123 ',
      r: '05-5140',
      t: 'C17',
      ownOp: 'United States Air Force',
      lat: 38.9,
      lon: -77.1,
      alt_baro: 31000,
      gs: 450,
      track: 270,
    },
    { hex: '~43c001', lat: 51.5, lon: -1.2, alt_baro: 'ground' },
    { hex: 'nopos' },
  ],
};

test('parses the military list with the operating service', () => {
  const out = parseMilitary(payload);
  assert.equal(out.length, 2);
  const [a, b] = out;
  assert.equal(a.type, 'military');
  assert.equal(a.id, 'ae1234');
  assert.equal(a.meta.callsign, 'RCH123');
  assert.equal(a.meta.operator, 'United States Air Force');
  assert.equal(a.meta.source, 'adsb.lol (military)');
  assert.ok(Math.abs(a.position.altitude - 31000 * 0.3048) < 1e-6);
  assert.equal(b.id, '43c001');
  assert.equal(b.meta.onGround, true);
  assert.equal(b.meta.operator, null);
});

test('the card shows the operator; search covers callsign, type and operator', () => {
  const [a] = parseMilitary(payload);
  const card = formatAircraft(a.meta);
  assert.deepEqual(
    card.rows.find(([k]) => k === 'Operator'),
    ['Operator', 'United States Air Force'],
  );
  assert.match(militarySearchText(a), /RCH123.*C17.*Air Force/);
});

test('tolerates an empty or malformed payload', () => {
  assert.deepEqual(parseMilitary(null), []);
  assert.deepEqual(parseMilitary({ ac: 'x' }), []);
});

test('the operator is shown only when it reads as a state body', () => {
  const out = parseMilitary({
    ac: [
      { hex: 'a00001', lat: 1, lon: 1, ownOp: 'Royal Air Force' },
      { hex: 'a00002', lat: 1, lon: 1, ownOp: 'Jane Q Smith' },
      { hex: 'a00003', lat: 1, lon: 1, ownOp: 'US Navy' },
      { hex: 'a00004', lat: 1, lon: 1, ownOp: 'Example Leasing LLC' },
    ],
  });
  assert.deepEqual(
    out.map((n) => n.meta.operator),
    ['Royal Air Force', null, 'US Navy', null],
  );
});
