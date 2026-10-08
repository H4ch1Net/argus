// Bikeshare systems with keyless GBFS feeds (station_information +
// station_status), the registry the reference project uses, reached through
// one proxy feed per host. Pure: registry, selection, and GBFS parsing.
//
// GBFS terms are per system and attribution-only; each card credits its
// operator. Station information changes rarely and is fetched once per system
// per session; status is polled.

import { insideView } from '../sdk/bbox.js';

const bcycle = (id, city, lat, lon, systemId) => ({
  id,
  city,
  center: [lat, lon],
  radiusKm: 60,
  provider: 'BCycle',
  feedId: 'gbfs-bcycle',
  base: `/${systemId}`,
});

/** @type {{ id: string, city: string, center: [number, number], radiusKm: number,
 *   provider: string, feedId: string, base: string }[]} */
export const BIKESHARE_SYSTEMS = [
  {
    id: 'nyc-citibike',
    city: 'New York',
    center: [40.7484, -73.9967],
    radiusKm: 60,
    provider: 'Citi Bike (Lyft)',
    feedId: 'gbfs-lyft',
    base: '/bkn/en',
  },
  {
    id: 'chicago-divvy',
    city: 'Chicago',
    center: [41.8781, -87.6298],
    radiusKm: 60,
    provider: 'Divvy (Lyft)',
    feedId: 'gbfs-lyft',
    base: '/chi/en',
  },
  {
    id: 'dc-capital-bikeshare',
    city: 'Washington, DC',
    center: [38.9072, -77.0369],
    radiusKm: 60,
    provider: 'Capital Bikeshare (Lyft)',
    feedId: 'gbfs-lyft',
    base: '/dca-cabi/en',
  },
  {
    id: 'sf-bay-wheels',
    city: 'San Francisco Bay Area',
    center: [37.7749, -122.4194],
    radiusKm: 70,
    provider: 'Bay Wheels (Lyft)',
    feedId: 'gbfs-lyft',
    base: '/bay/en',
  },
  {
    id: 'boston-bluebikes',
    city: 'Boston',
    center: [42.3601, -71.0589],
    radiusKm: 50,
    provider: 'Bluebikes',
    feedId: 'gbfs-bluebikes',
    base: '',
  },
  {
    id: 'portland-biketown',
    city: 'Portland, OR',
    center: [45.5152, -122.6784],
    radiusKm: 40,
    provider: 'BIKETOWN',
    feedId: 'gbfs-biketown',
    base: '',
  },
  {
    id: 'columbus-cogo',
    city: 'Columbus, OH',
    center: [39.9612, -82.9988],
    radiusKm: 40,
    provider: 'CoGo',
    feedId: 'gbfs-cogo',
    base: '',
  },
  {
    id: 'austin-capmetro',
    city: 'Austin',
    center: [30.2672, -97.7431],
    radiusKm: 40,
    provider: 'CapMetro Bikeshare',
    feedId: 'gbfs-austin',
    base: '',
  },
  {
    id: 'honolulu-biki',
    city: 'Honolulu',
    center: [21.3069, -157.8583],
    radiusKm: 40,
    provider: 'Biki',
    feedId: 'gbfs-honolulu',
    base: '',
  },
  bcycle('philadelphia-indego', 'Philadelphia', 39.9526, -75.1652, 'bcycle_indego'),
  bcycle('la-metro-bike', 'Los Angeles', 34.0522, -118.2437, 'bcycle_lametro'),
  bcycle('boulder-bcycle', 'Boulder', 40.015, -105.2705, 'bcycle_boulder'),
  bcycle('madison-bcycle', 'Madison', 43.0731, -89.4012, 'bcycle_madison'),
  bcycle('nashville-bcycle', 'Nashville', 36.1627, -86.7816, 'bcycle_nashville'),
  bcycle(
    'salt-lake-greenbike',
    'Salt Lake City',
    40.7608,
    -111.891,
    'bcycle_greenbikeslc',
  ),
  bcycle('san-antonio-bcycle', 'San Antonio', 29.4241, -98.4936, 'bcycle_sanantonio'),
];

export const BIKESHARE_MAX_SPAN_DEG = 3;
const KM_PER_DEG = 111.32;

export function systemsInView(bbox, systems = BIKESHARE_SYSTEMS) {
  if (!bbox) return { systems: [], tooWide: false };
  if (bbox.lamax - bbox.lamin > BIKESHARE_MAX_SPAN_DEG)
    return { systems: [], tooWide: true };
  return {
    systems: systems.filter(({ center: [lat, lon], radiusKm }) => {
      const dLat = radiusKm / KM_PER_DEG;
      const dLon = radiusKm / (KM_PER_DEG * Math.cos((lat * Math.PI) / 180));
      return (
        lat - dLat <= bbox.lamax &&
        lat + dLat >= bbox.lamin &&
        lon - dLon <= bbox.lomax &&
        lon + dLon >= bbox.lomin
      );
    }),
    tooWide: false,
  };
}

const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const flag = (v) =>
  v == null ? null : v === true || v === 1 || v === '1' || v === 'true';
// GBFS 3 localizes names as [{ text, language }]; GBFS 2 uses a string.
const name = (v) =>
  typeof v === 'string'
    ? v.trim()
    : Array.isArray(v)
      ? String(v[0]?.text ?? '').trim()
      : '';
const stationsOf = (payload) =>
  Array.isArray(payload?.data?.stations)
    ? payload.data.stations
    : Array.isArray(payload?.data)
      ? payload.data
      : [];

/**
 * Join a system's station_information and station_status into station records.
 * @returns {object[]} { id, name, lat, lon, capacity, bikes, docks, renting, returning, lastReported }
 */
export function joinStations(info, status) {
  const byId = new Map();
  for (const s of stationsOf(status)) {
    const id = s?.station_id ?? s?.id;
    if (id != null) byId.set(String(id), s);
  }
  const out = [];
  for (const s of stationsOf(info)) {
    const id = s?.station_id ?? s?.id;
    const lat = num(s?.lat ?? s?.latitude);
    const lon = num(s?.lon ?? s?.longitude);
    if (id == null || lat === null || lon === null || (lat === 0 && lon === 0)) continue;
    const st = byId.get(String(id)) || {};
    if (flag(st.is_installed) === false) continue;
    out.push({
      id: String(id),
      name: name(s.name) || name(s.short_name) || `Station ${id}`,
      lat,
      lon,
      capacity: num(s.capacity),
      bikes: num(st.num_bikes_available ?? st.num_vehicles_available),
      docks: num(st.num_docks_available),
      renting: flag(st.is_renting),
      returning: flag(st.is_returning),
      lastReported: num(st.last_reported),
    });
  }
  return out;
}

/**
 * The layer's source: systems in view, station information cached per system
 * (6 hours), status fetched every poll.
 */
export function createBikeshareSource({ proxyClient, systems = BIKESHARE_SYSTEMS }) {
  const infoCache = new Map(); // system id -> { at, data }
  const INFO_TTL_MS = 6 * 60 * 60 * 1000;
  const getInfo = async (sys, signal) => {
    const hit = infoCache.get(sys.id);
    if (hit && Date.now() - hit.at < INFO_TTL_MS) return hit.data;
    const data = await proxyClient.getJson(
      sys.feedId,
      `${sys.base}/station_information.json`,
      { signal },
    );
    infoCache.set(sys.id, { at: Date.now(), data });
    return data;
  };
  return async (query, signal) => {
    const view = systemsInView(query?.bbox, systems);
    const settled = await Promise.allSettled(
      view.systems.map(async (sys) => {
        const [info, status] = await Promise.all([
          getInfo(sys, signal),
          proxyClient.getJson(sys.feedId, `${sys.base}/station_status.json`, { signal }),
        ]);
        return joinStations(info, status).map((st) => ({ ...st, system: sys }));
      }),
    );
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const failed = settled.filter((r) => r.status === 'rejected');
    if (failed.length && !ok.length) throw failed[0].reason;
    const inside = insideView(query?.bbox);
    return {
      stations: ok.flatMap((r) => r.value).filter((st) => inside(st.lat, st.lon)),
      tooWide: view.tooWide,
      inView: view.systems.length,
      failed: failed.length,
    };
  };
}
