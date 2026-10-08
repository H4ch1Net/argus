// A minimal GTFS-RT VehiclePositions encoder: the inverse of gtfsrt.js, used by
// the tests and by the offline demo source (so demo data runs through the real
// decoder). Not used on live data. Pure.

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
export const vint = (field, n) => [...key(field, 0), ...varint(n)];
export const bytes = (field, b) => [...key(field, 2), ...varint(b.length), ...b];
export const text = (field, s) => bytes(field, [...enc.encode(s)]);
export const msg = (field, parts) => bytes(field, parts.flat());
export function f32(field, x) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, x, true);
  return [...key(field, 5), ...b];
}
export const fixed64 = (field) => [...key(field, 1), 1, 2, 3, 4, 5, 6, 7, 8];

const STATUS = { incoming: 0, stopped: 1, 'in transit': 2 };

/** One FeedEntity (field 2 of FeedMessage) carrying a VehiclePosition. */
export function vehicleEntity(v) {
  const position = [f32(1, v.lat), f32(2, v.lon)];
  if (v.bearing != null) position.push(f32(3, v.bearing));
  if (v.speed != null) position.push(f32(5, v.speed));
  const trip = [];
  if (v.tripId) trip.push(text(1, v.tripId));
  if (v.routeId) trip.push(text(5, v.routeId));
  if (v.directionId != null) trip.push(vint(6, v.directionId));
  const descriptor = [];
  if (v.vehicleId) descriptor.push(text(1, v.vehicleId));
  if (v.label) descriptor.push(text(2, v.label));
  if (v.plate) descriptor.push(text(3, v.plate));
  const vp = [];
  if (trip.length) vp.push(msg(1, trip));
  vp.push(msg(2, position));
  if (v.status) vp.push(vint(4, STATUS[v.status]));
  if (v.timestamp) vp.push(vint(5, v.timestamp));
  if (descriptor.length) vp.push(msg(8, descriptor));
  return msg(2, [text(1, v.id), v.deleted ? vint(2, 1) : [], msg(4, vp)]);
}

/** A whole FeedMessage. */
export function encodeVehicleFeed({ timestamp = 0, vehicles = [], extra = [] } = {}) {
  const header = msg(1, [text(1, '2.0'), timestamp ? vint(3, timestamp) : []]);
  return new Uint8Array([...header, ...extra, ...vehicles.flatMap(vehicleEntity)]);
}
