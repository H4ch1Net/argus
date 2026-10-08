// Decoded GTFS-RT feeds (from source.js) -> normalized transit vehicles. Pure.
// Vehicle ids are only unique within an agency, so ids are prefixed with the
// feed. Fixes older than ten minutes are dropped (a parked or lost vehicle).

const MAX_AGE_MS = 10 * 60 * 1000;

/**
 * @param {{ feeds?: { agency: object, timestamp: number|null, vehicles: object[] }[] }} result
 * @param {number} [now]
 * @returns {object[]}
 */
export function parseTransit(result, now = Date.now()) {
  const out = [];
  for (const feed of result?.feeds ?? []) {
    const a = feed.agency;
    for (const v of feed.vehicles ?? []) {
      const ts = v.timestamp ?? feed.timestamp ?? null;
      if (ts && now - ts * 1000 > MAX_AGE_MS) continue;
      out.push({
        id: `${a.feedId}:${v.id}`,
        type: 'transit',
        position: { longitude: v.longitude, latitude: v.latitude, altitude: 0 },
        velocity: { speed: v.speed, heading: v.bearing },
        meta: {
          agency: a.name,
          region: a.region,
          license: a.license ?? null,
          vehicleId: v.id,
          label: v.label,
          routeId: v.routeId,
          tripId: v.tripId,
          directionId: v.directionId,
          status: v.status,
          speed: v.speed,
          bearing: v.bearing,
          timestamp: ts,
          demo: Boolean(a.demo),
        },
      });
    }
  }
  return out;
}

/** A short status hint for the readout / terminal (why the layer may be empty). */
export function transitNote(result) {
  if (!result) return '';
  if (result.tooWide) return 'zoom to a covered city';
  if (!result.inView) return 'no covered agency in view';
  if (result.failed?.length)
    return `${result.failed.map((f) => f.agency).join(', ')} failed`;
  return '';
}
