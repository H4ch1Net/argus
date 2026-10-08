import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeVehiclePositions } from './gtfsrt.js';
import {
  encodeVehicleFeed,
  vehicleEntity,
  msg,
  text,
  vint,
  f32,
  fixed64,
} from './encode.js';

const base = {
  id: 'a',
  vehicleId: 'veh-a',
  label: 'Bus a',
  tripId: 'trip-9',
  routeId: 'route-44',
  directionId: 1,
  lat: 47.6,
  lon: -122.3,
  bearing: 90,
  speed: 8.5,
  status: 'in transit',
  timestamp: 1_700_000_000,
};
const feed = (...vehicles) => encodeVehicleFeed({ timestamp: 1_700_000_100, vehicles });

test('decodes vehicle positions with trip, route, bearing and status', () => {
  const out = decodeVehiclePositions(feed(base));
  assert.equal(out.timestamp, 1_700_000_100);
  assert.equal(out.vehicles.length, 1);
  const v = out.vehicles[0];
  assert.equal(v.entityId, 'a');
  assert.equal(v.id, 'veh-a');
  assert.equal(v.label, 'Bus a');
  assert.equal(v.routeId, 'route-44');
  assert.equal(v.tripId, 'trip-9');
  assert.equal(v.directionId, 1);
  assert.ok(Math.abs(v.latitude - 47.6) < 1e-5);
  assert.ok(Math.abs(v.longitude + 122.3) < 1e-5);
  assert.equal(v.bearing, 90);
  assert.equal(v.speed, 8.5);
  assert.equal(v.status, 'in transit');
  assert.equal(v.timestamp, 1_700_000_000);
});

test('never surfaces the license plate field', () => {
  const out = decodeVehiclePositions(feed({ ...base, plate: 'ABC123' }));
  assert.equal(out.vehicles.length, 1);
  assert.ok(!JSON.stringify(out).includes('ABC123'));
});

test('skips deleted entities and unset (0,0) positions', () => {
  const out = decodeVehiclePositions(
    feed(
      { ...base, id: 'keep' },
      { ...base, id: 'gone', deleted: true },
      { ...base, id: 'null', lat: 0, lon: 0 },
    ),
  );
  assert.deepEqual(
    out.vehicles.map((v) => v.entityId),
    ['keep'],
  );
});

test('skips entities without a vehicle position (trip updates, alerts)', () => {
  const tripUpdate = msg(2, [text(1, 'tu'), msg(3, [msg(1, [text(1, 'trip')])])]);
  const bytes = new Uint8Array([...tripUpdate, ...vehicleEntity({ ...base, id: 'v' })]);
  assert.deepEqual(
    decodeVehiclePositions(bytes).vehicles.map((v) => v.entityId),
    ['v'],
  );
});

test('ignores unknown fields of every wire type', () => {
  const extra = [...fixed64(99), ...vint(98, 7), ...text(97, 'x'), ...f32(96, 1)];
  const out = decodeVehiclePositions(encodeVehicleFeed({ vehicles: [base], extra }));
  assert.equal(out.vehicles.length, 1);
});

test('accepts an ArrayBuffer and an empty feed', () => {
  const buf = feed(base);
  assert.equal(decodeVehiclePositions(buf.buffer.slice(0)).vehicles.length, 1);
  assert.deepEqual(decodeVehiclePositions(new Uint8Array(0)), {
    timestamp: null,
    vehicles: [],
  });
});

test('throws on truncated input instead of returning garbage', () => {
  const buf = feed(base);
  assert.throws(() => decodeVehiclePositions(buf.subarray(0, buf.length - 3)));
});
