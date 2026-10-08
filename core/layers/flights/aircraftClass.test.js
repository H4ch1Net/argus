import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAircraft,
  AIRCRAFT_CLASSES,
  AIRCRAFT_CLASS_LABELS,
  AIRCRAFT_CLASS_SCALE,
} from './aircraftClass.js';

test('type designators pick the silhouette class', () => {
  assert.equal(classifyAircraft({ typeCode: 'B789' }), 'widebody');
  assert.equal(classifyAircraft({ typeCode: 'a388' }), 'quadjet');
  assert.equal(classifyAircraft({ typeCode: ' R44 ' }), 'helicopter');
  assert.equal(classifyAircraft({ typeCode: 'AT76' }), 'turboprop');
  assert.equal(classifyAircraft({ typeCode: 'C172' }), 'light');
  assert.equal(classifyAircraft({ typeCode: 'GLF6' }), 'bizjet');
  assert.equal(classifyAircraft({ typeCode: 'F16' }), 'fastjet');
  assert.equal(classifyAircraft({ typeCode: 'MQ9' }), 'uav');
  assert.equal(classifyAircraft({ typeCode: 'ASK' }), 'glider');
  assert.equal(classifyAircraft({ typeCode: 'A320' }), 'airliner', 'unlisted jets');
});

test('categories are the fallback when no type is known', () => {
  assert.equal(classifyAircraft({ category: 8 }), 'helicopter'); // OpenSky integer
  assert.equal(classifyAircraft({ category: 'A7' }), 'helicopter'); // ADS-B emitter
  assert.equal(classifyAircraft({ category: 'a1' }), 'light');
  assert.equal(classifyAircraft({ category: 6 }), 'widebody');
  assert.equal(classifyAircraft({}), 'airliner');
  assert.equal(classifyAircraft(), 'airliner');
  assert.equal(
    classifyAircraft({ typeCode: 'C172', category: 'A5' }),
    'light',
    'type wins',
  );
});

test('every class has a label and a scale', () => {
  for (const c of AIRCRAFT_CLASSES) {
    assert.ok(AIRCRAFT_CLASS_LABELS[c], c);
    assert.ok(AIRCRAFT_CLASS_SCALE[c] > 0, c);
  }
});
