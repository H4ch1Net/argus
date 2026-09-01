import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFires } from './parse.js';

const CSV = `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight
38.1,-120.5,330.1,0.4,0.4,2026-08-30,0742,N,VIIRS,h,2.0NRT,295.2,12.4,D
-3.2,120.1,367.0,0.5,0.5,2026-08-30,1330,N,VIIRS,n,2.0NRT,300.0,88.0,N`;

test('parses FIRMS CSV by header name', () => {
  const out = parseFires(CSV);
  assert.equal(out.length, 2);
  const f = out[0];
  assert.equal(f.type, 'fire');
  assert.deepEqual(f.position, { longitude: -120.5, latitude: 38.1, altitude: 0 });
  assert.equal(f.meta.frp, 12.4);
  assert.equal(f.meta.confidence, 'h');
  assert.equal(f.meta.acqDate, '2026-08-30');
  assert.ok(f.id.includes('2026-08-30'));
});

test('skips rows without coordinates and tolerates empty input', () => {
  const bad = CSV + '\n,,,,,,,,,,,,,';
  assert.equal(parseFires(bad).length, 2);
  assert.deepEqual(parseFires(''), []);
  assert.deepEqual(parseFires('latitude,longitude'), []);
});
