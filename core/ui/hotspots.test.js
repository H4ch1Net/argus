import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankHotspots } from './hotspots.js';

const rec = (id, lat, lon, meta = {}) => ({
  id,
  position: { latitude: lat, longitude: lon },
  meta,
});

test('hotspots rank notable records and keep them apart', () => {
  const out = rankHotspots(
    [
      { key: 'quakes', n: rec('q1', 35, 139, { mag: 6.1, place: 'Honshu' }) },
      { key: 'quakes', n: rec('q2', 35.1, 139.1, { mag: 5.0 }) }, // too close to q1
      { key: 'quakes', n: rec('q3', -20, -70, { mag: 3.2 }) }, // below the floor
      { key: 'fires', n: rec('f1', 37, -120, { frp: 80 }) },
      { key: 'flights', n: rec('a1', 51, 0, { callsign: 'BAW1' }) },
      { key: 'radio', n: rec('r1', 0, 0) }, // not a hotspot layer
    ],
    { random: () => 0.5 },
  );
  assert.deepEqual(
    out.map((h) => h.id),
    ['f1', 'q1', 'a1'],
  );
  assert.equal(out.find((h) => h.id === 'q1').label, 'Honshu');
  assert.ok(out.every((h) => h.range > 0));
});

test('nothing on, nothing to tour', () => {
  assert.deepEqual(rankHotspots([]), []);
});
