import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  directionToHeading,
  hashSeed,
  fallbackHeading,
  posePrior,
  POSE_PERSONALITIES,
  compassPoint,
} from './pose.js';

test('direction text: travel tokens anywhere, bare cardinals only in direction fields', () => {
  assert.equal(directionToHeading('Northbound'), 0);
  assert.equal(directionToHeading('US-290 EB'), 90);
  assert.equal(directionToHeading('I-35 SB @ 6th'), 180);
  assert.equal(directionToHeading('westbound'), 270);
  assert.equal(directionToHeading('NE'), 45);
  assert.equal(directionToHeading('looking SW'), 225);
  // Street names are full of cardinal words: a free-form name never yields one.
  assert.equal(directionToHeading('N LAMAR BLVD / WEST AVE'), null);
  assert.equal(directionToHeading('5TH ST / WEST AVE'), null);
  // A dedicated direction field: "West" IS the facing.
  assert.equal(directionToHeading('West', true), 270);
  assert.equal(directionToHeading('south', true), 180);
  // Tokens must be whole words.
  assert.equal(directionToHeading('NBC Tower'), null);
  assert.equal(directionToHeading('WESTON RD', true), null);
  for (const empty of ['', '   ', null, undefined]) {
    assert.equal(directionToHeading(empty, true), null);
  }
});

test('the hash fallback is deterministic, one of 16 bearings, and spreads ids', () => {
  assert.equal(hashSeed(''), 2166136261);
  assert.equal(hashSeed('a'), 0xe40c292c); // FNV-1a test vector
  const a = fallbackHeading('fi-c0150301');
  assert.equal(a, fallbackHeading('fi-c0150301'));
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const h = fallbackHeading(`cam-${i}`);
    assert.ok(h >= 0 && h < 360 && Number.isInteger(h / 22.5));
    seen.add(h);
  }
  assert.ok(seen.size >= 12, 'ids fan out over the compass');
});

test('two pose personalities: a stated heading looks further than a guessed one', () => {
  const known = posePrior({ id: 'x', headingDeg: 450 });
  assert.equal(known.heading, 90);
  assert.equal(known.headingConfidence, 'high');
  assert.equal(known.headingSource, 'feed');
  assert.deepEqual(
    {
      pitch: known.pitch,
      fovDeg: known.fovDeg,
      rangeM: known.rangeM,
      heightM: known.heightM,
    },
    POSE_PERSONALITIES.known,
  );
  assert.equal(known.groundM, null);

  const unknown = posePrior({ id: 'x', headingDeg: null, groundM: 1045 });
  assert.equal(unknown.heading, fallbackHeading('x'));
  assert.equal(unknown.headingConfidence, 'low');
  assert.equal(unknown.headingSource, 'hash');
  assert.equal(unknown.pitch, 18);
  assert.equal(unknown.fovDeg, 44);
  assert.equal(unknown.rangeM, 145);
  assert.equal(unknown.heightM, 8);
  assert.equal(unknown.groundM, 1045);
  assert.ok(known.rangeM > unknown.rangeM && known.pitch > unknown.pitch);
});

test('curated, low-confidence, network mounts and measured overrides', () => {
  // A curated rough bearing keeps its heading but the modest personality.
  const rough = posePrior({
    id: 't',
    headingDeg: 60.1,
    confidence: 'low',
    curated: true,
  });
  assert.equal(rough.heading, 60.1);
  assert.equal(rough.headingSource, 'curated');
  assert.equal(rough.headingConfidence, 'low');
  assert.equal(rough.rangeM, 145);
  // TxDOT mounts run tall.
  const mountM = { known: 12, unknown: 10 };
  assert.equal(posePrior({ id: 'a', headingDeg: 90, mountM }).heightM, 12);
  assert.equal(posePrior({ id: 'a', mountM }).heightM, 10);
  // A measured pose wins over the personality; junk overrides are ignored.
  const measured = posePrior({
    id: 'w',
    headingDeg: 221,
    curated: true,
    groundM: 55,
    overrides: { pitch: 23, fovDeg: 84, rangeM: 260, heightM: 14 },
  });
  assert.deepEqual(measured, {
    heading: 221,
    headingConfidence: 'high',
    headingSource: 'curated',
    pitch: 23,
    fovDeg: 84,
    rangeM: 260,
    heightM: 14,
    groundM: 55,
  });
  assert.equal(posePrior({ id: 'a', overrides: { rangeM: 'far' } }).rangeM, 145);
  assert.equal(posePrior({ id: 'a', headingDeg: Number.NaN }).headingSource, 'hash');
});

test('compass points round to the nearest of eight', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(22), 'N');
  assert.equal(compassPoint(23), 'NE');
  assert.equal(compassPoint(227.2), 'SW');
  assert.equal(compassPoint(350), 'N');
  assert.equal(compassPoint(-90), 'W');
});
