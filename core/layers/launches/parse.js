// Rocket launches from Launch Library 2 (The Space Devs), grouped by launch pad:
// one marker per pad, carrying that pad's launches in the query window (a week
// back to six weeks ahead). Pure.
//
// LL2 2.3.0 launch fields read here: id, name, net (ISO), status { name, abbrev },
// launch_service_provider { name }, rocket { configuration { full_name, name } },
// mission { name, orbit { name } }, pad { id, name, latitude, longitude,
// location { name } }. Older responses send latitude/longitude as strings.

const DAY = 24 * 60 * 60 * 1000;

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const text = (v, max = 120) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/** Day-rounded window, so the request URL (and the proxy's cache key) is stable. */
export function launchWindow(now = Date.now()) {
  const day = Math.floor(now / DAY) * DAY;
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  return { net__gte: iso(day - 7 * DAY), net__lte: iso(day + 45 * DAY) };
}

/** Query parameters for the proxy request. */
export function launchQuery(now = Date.now()) {
  return { ...launchWindow(now), ordering: 'net', limit: 100, mode: 'normal' };
}

function launchOf(l) {
  const net = Date.parse(l?.net ?? l?.window_start ?? '');
  return {
    id: String(l.id ?? l.slug ?? l.name),
    name: text(l.name) || 'Launch',
    net: Number.isFinite(net) ? net : null,
    status: text(l.status?.name, 40),
    abbrev: text(l.status?.abbrev, 16),
    provider: text(l.launch_service_provider?.name),
    rocket: text(l.rocket?.configuration?.full_name || l.rocket?.configuration?.name),
    mission: text(l.mission?.name),
    orbit: text(l.mission?.orbit?.name, 60),
  };
}

/** The launch a pad marker is "about": the next one ahead, else the latest. */
export function primaryLaunch(launches, now = Date.now()) {
  const ahead = launches.filter((l) => l.net != null && l.net >= now);
  if (ahead.length) return ahead[0];
  return launches[launches.length - 1] ?? null;
}

/**
 * @param {{ results?: object[] }} payload
 * @returns {object[]} one normalized entity per pad (type 'launch-pad')
 */
export function parseLaunches(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  const pads = new Map();
  for (const l of results) {
    const pad = l?.pad;
    const latitude = num(pad?.latitude);
    const longitude = num(pad?.longitude);
    if (latitude === null || longitude === null) continue;
    const key = String(pad.id ?? `${latitude},${longitude}`);
    if (!pads.has(key)) {
      pads.set(key, {
        id: `pad:${key}`,
        type: 'launch-pad',
        position: { longitude, latitude, altitude: 0 },
        meta: {
          pad: text(pad.name) || 'Launch pad',
          location: text(pad.location?.name),
          launches: [],
          demo: Boolean(payload?.demo),
        },
      });
    }
    pads.get(key).meta.launches.push(launchOf(l));
  }
  for (const p of pads.values())
    p.meta.launches.sort((a, b) => (a.net ?? 0) - (b.net ?? 0));
  return [...pads.values()];
}
