// Watch areas (master plan 8, "proximity / geofence alerts"): circles the user
// places on the map; contacts that enter or leave one raise a notice. Pure: the
// caller feeds positions, this keeps who is inside each area and reports the
// changes. Areas and contacts are public data on this device; nothing is sent.

const R = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. */
export function haversineM(lat1, lon1, lat2, lon2) {
  const a =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) *
      Math.cos(lat2 * RAD) *
      Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** A cheap bounding check before the exact distance (degrees of latitude). */
const latSpan = (radiusM) => radiusM / 111_195;

/**
 * @param {{ onEnter?: Function, onExit?: Function }} [hooks]
 */
export function createGeofences({ onEnter, onExit } = {}) {
  const areas = new Map(); // id -> { id, name, lat, lon, radiusM, inside: Set }
  let seq = 0;
  return {
    /** Add a circular area; returns its id. */
    add({ name, lat, lon, radiusM }) {
      if (![lat, lon, radiusM].every(Number.isFinite) || radiusM <= 0) return null;
      seq += 1;
      const id = `w${seq}`;
      areas.set(id, {
        id,
        name: String(name || `AREA ${seq}`).slice(0, 40),
        lat,
        lon,
        radiusM: Math.min(radiusM, 2_000_000),
        inside: new Set(),
      });
      return id;
    },
    remove(id) {
      areas.delete(id);
    },
    list: () =>
      [...areas.values()].map(({ inside, ...a }) => ({ ...a, count: inside.size })),
    /**
     * Check a batch of contacts: [{ key, id, lat, lon, label }]. Calls onEnter
     * and onExit for changes since the last check (a contact missing from the
     * batch counts as gone only when `complete` is true).
     */
    check(contacts, { complete = true } = {}) {
      for (const area of areas.values()) {
        const dLat = latSpan(area.radiusM);
        const now = new Set();
        for (const c of contacts) {
          if (Math.abs(c.lat - area.lat) > dLat) continue;
          if (haversineM(area.lat, area.lon, c.lat, c.lon) > area.radiusM) continue;
          const k = `${c.key}:${c.id}`;
          now.add(k);
          if (!area.inside.has(k)) onEnter?.(area, c);
        }
        if (complete) {
          for (const k of area.inside) if (!now.has(k)) onExit?.(area, k);
          area.inside = now;
        } else {
          for (const k of now) area.inside.add(k);
        }
      }
    },
    get size() {
      return areas.size;
    },
  };
}
