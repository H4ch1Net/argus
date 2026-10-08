// GTFS-Realtime vehicle positions, decoded without a protobuf library. Pure.
//
// GTFS-RT feeds are protocol buffers (FeedMessage). Only a handful of fields are
// needed for a live-vehicle layer, so this reads the wire format directly:
// varints, 32/64-bit fixed values, and length-delimited submessages. Unknown
// fields are skipped, so feeds with extensions decode fine.
//
//   FeedMessage   { 1 header: FeedHeader, 2 entity: FeedEntity[] }
//   FeedHeader    { 3 timestamp: uint64 }
//   FeedEntity    { 1 id: string, 2 is_deleted: bool, 4 vehicle: VehiclePosition }
//   VehiclePosition { 1 trip: TripDescriptor, 2 position: Position, 4 current_status,
//                     5 timestamp: uint64, 8 vehicle: VehicleDescriptor, 9 occupancy }
//   Position      { 1 latitude: float, 2 longitude: float, 3 bearing: float, 5 speed: float (m/s) }
//   TripDescriptor { 1 trip_id, 5 route_id, 6 direction_id }
//   VehicleDescriptor { 1 id, 2 label }   (field 3, license_plate, is never read)

const textDecoder = new TextDecoder();

/** Iterate the fields of one protobuf message: yields { field, wire, value }. */
function* fields(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (pos >= bytes.length) throw new Error('truncated varint');
      const b = bytes[pos++];
      // Numbers above 2^53 lose precision; nothing read here gets that large.
      result += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return result;
      shift += 7;
      if (shift > 63) throw new Error('varint too long');
    }
  };
  while (pos < bytes.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let value;
    if (wire === 0) value = varint();
    else if (wire === 1) {
      if (pos + 8 > bytes.length) throw new Error('truncated fixed64');
      value = {
        lo: view.getUint32(pos, true),
        hi: view.getUint32(pos + 4, true),
        at: pos,
      };
      pos += 8;
    } else if (wire === 2) {
      const len = varint();
      if (pos + len > bytes.length) throw new Error('truncated field');
      value = bytes.subarray(pos, pos + len);
      pos += len;
    } else if (wire === 5) {
      if (pos + 4 > bytes.length) throw new Error('truncated fixed32');
      value = view.getFloat32(pos, true);
      pos += 4;
    } else {
      throw new Error(`unsupported wire type ${wire}`);
    }
    yield { field, wire, value };
  }
}

const str = (v) => (v instanceof Uint8Array ? textDecoder.decode(v) : null);

function decodePosition(bytes) {
  const p = {};
  for (const { field, wire, value } of fields(bytes)) {
    if (wire !== 5) continue;
    if (field === 1) p.latitude = value;
    else if (field === 2) p.longitude = value;
    else if (field === 3) p.bearing = value;
    else if (field === 5) p.speed = value;
  }
  return p;
}

function decodeTrip(bytes) {
  const t = {};
  for (const { field, value } of fields(bytes)) {
    if (field === 1) t.tripId = str(value);
    else if (field === 5) t.routeId = str(value);
    else if (field === 6 && typeof value === 'number') t.directionId = value;
  }
  return t;
}

function decodeVehicleDescriptor(bytes) {
  const d = {};
  for (const { field, value } of fields(bytes)) {
    if (field === 1) d.id = str(value);
    else if (field === 2) d.label = str(value);
    // field 3 (license_plate) is deliberately ignored.
  }
  return d;
}

const STATUS = ['incoming', 'stopped', 'in transit'];

function decodeVehiclePosition(bytes) {
  const v = {};
  for (const { field, wire, value } of fields(bytes)) {
    if (field === 1 && wire === 2) v.trip = decodeTrip(value);
    else if (field === 2 && wire === 2) v.position = decodePosition(value);
    else if (field === 4 && wire === 0) v.status = STATUS[value] ?? null;
    else if (field === 5 && wire === 0) v.timestamp = value;
    else if (field === 8 && wire === 2) v.vehicle = decodeVehicleDescriptor(value);
  }
  return v;
}

/**
 * Decode a GTFS-RT FeedMessage into vehicles with positions.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{ timestamp: number|null, vehicles: object[] }}
 */
export function decodeVehiclePositions(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let timestamp = null;
  const vehicles = [];
  for (const { field, wire, value } of fields(bytes)) {
    if (field === 1 && wire === 2) {
      for (const h of fields(value))
        if (h.field === 3 && h.wire === 0) timestamp = h.value;
    } else if (field === 2 && wire === 2) {
      let id = null;
      let deleted = false;
      let vp = null;
      for (const e of fields(value)) {
        if (e.field === 1) id = str(e.value);
        else if (e.field === 2 && e.wire === 0) deleted = Boolean(e.value);
        else if (e.field === 4 && e.wire === 2) vp = decodeVehiclePosition(e.value);
      }
      const p = vp?.position;
      if (deleted || !p || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude))
        continue;
      if (p.latitude === 0 && p.longitude === 0) continue; // unset position
      vehicles.push({
        entityId: id,
        id: vp.vehicle?.id || id,
        label: vp.vehicle?.label || null,
        routeId: vp.trip?.routeId || null,
        tripId: vp.trip?.tripId || null,
        directionId: vp.trip?.directionId ?? null,
        latitude: p.latitude,
        longitude: p.longitude,
        bearing: Number.isFinite(p.bearing) ? p.bearing : null,
        speed: Number.isFinite(p.speed) ? p.speed : null, // m/s
        status: vp.status ?? null,
        timestamp: vp.timestamp ?? null, // seconds since epoch
      });
    }
  }
  return { timestamp, vehicles };
}
