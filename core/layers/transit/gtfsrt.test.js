import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeVehiclePositions } from './gtfsrt.js';

// A minimal protobuf encoder, enough to build GTFS-RT FeedMessages by hand.
const enc = new TextEncoder();
function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}
const key = (field, wire) => varint(field * 8 + wire);
const vint = (field, n) => [...key(field, 0), ...varint(n)];
const bytes = (field, b) => [...key(field, 2), ...varint(b.length), ...b];
const text = (field, s) => bytes(field, [...enc.encode(s)]);
const msg = (field, parts) => bytes(field, parts.flat());
function f32(field, x) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x, true);
  return [...key(field, 5), ...b];
}
const fixed64 = (field) => [...key(field, 1), 1, 2, 3, 4, 5, 6, 7, 8];

function vehicleEntity(id, { lat = 47.6, lon = -122.3, deleted = false, plate } = {}) {
  return msg(2, [
    text(1, id),
    deleted ? vint(2, 1) : [],
    msg(4, [
      msg(1, [text(1, 'trip-9'), text(5, 'route-44'), vint(6, 1)]),
      msg(2, [f32(1, lat), f32(2, lon), f32(3, 90), f32(5, 8.5)]),
      vint(4, 2),
      vint(5, 1_700_000_000),
      msg(8, [text(1, 'veh-' + id), text(2, 'Bus ' + id), plate ? text(3, plate) : []]),
    ]),
  ]);
}

const header = msg(1, [text(1, '2.0'), vint(3, 1_700_000_100)]);
const feed = (...entities) => new Uint8Array([...header, ...entities.flat()]);

test('decodes vehicle positions with trip, route, bearing and status', () => {
  const out = decodeVehiclePositions(feed(vehicleEntity('a')));
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
  const out = decodeVehiclePositions(feed(vehicleEntity('p', { plate: 'ABC123' })));
  assert.equal(out.vehicles.length, 1);
  assert.ok(!JSON.stringify(out).includes('ABC123'));
});

test('skips deleted entities and unset (0,0) positions', () => {
  const out = decodeVehiclePositions(
    feed(
      vehicleEntity('keep'),
      vehicleEntity('gone', { deleted: true }),
      vehicleEntity('null', { lat: 0, lon: 0 }),
    ),
  );
  assert.deepEqual(
    out.vehicles.map((v) => v.entityId),
    ['keep'],
  );
});

test('skips entities without a vehicle position (trip updates, alerts)', () => {
  const tripUpdate = msg(2, [text(1, 'tu'), msg(3, [msg(1, [text(1, 'trip')])])]);
  const out = decodeVehiclePositions(feed(tripUpdate, vehicleEntity('v')));
  assert.deepEqual(
    out.vehicles.map((v) => v.entityId),
    ['v'],
  );
});

test('ignores unknown fields of every wire type', () => {
  const extra = [...fixed64(99), ...vint(98, 7), ...text(97, 'x'), ...f32(96, 1)];
  const out = decodeVehiclePositions(
    new Uint8Array([...header, ...extra, ...vehicleEntity('v')]),
  );
  assert.equal(out.vehicles.length, 1);
});

test('accepts an ArrayBuffer and an empty feed', () => {
  const buf = feed(vehicleEntity('v'));
  assert.equal(decodeVehiclePositions(buf.buffer.slice(0)).vehicles.length, 1);
  assert.deepEqual(decodeVehiclePositions(new Uint8Array(0)), {
    timestamp: null,
    vehicles: [],
  });
});

test('throws on truncated input instead of returning garbage', () => {
  const buf = feed(vehicleEntity('v'));
  assert.throws(() => decodeVehiclePositions(buf.subarray(0, buf.length - 3)));
});
