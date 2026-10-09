// A stand-in proxy client for navigation in a dev session with no proxy (the
// layers' mocks do the same): synthetic answers in the real routers' formats,
// so the real parsers, the progress engine and the panels all run. Labelled
// DEMO in the UI, never used when a proxy answers.
//
//   osrm: an L-shaped route along a 0.002 degree "street grid" (two
//     alternatives: north-south first, or east-west first), 11 m/s;
//   photon: the bundled places, plus three demo places near the bias;
//   overpass: a signal at every third grid crossing in the box asked for;
//   nominatim /reverse: a demo street name.
// Anything else answers 404, so the navigator falls back as it would live.

import { searchPlaces } from '../search/places.js';
import { haversineM } from './geo.js';

const GRID = 0.002;
const SPEED = 11;
const snap = (v) => Math.round(v / GRID) * GRID;
const r6 = (v) => Number(v.toFixed(6));

function notFound(feed) {
  return Object.assign(new Error(`demo proxy has no ${feed}`), { status: 404 });
}

/** Points every grid step from a to b along one axis (inclusive of b). */
function walk(from, to, fixed, axis) {
  const out = [];
  const n = Math.max(1, Math.round(Math.abs(to - from) / GRID));
  for (let i = 1; i <= n; i += 1) {
    const v = from + ((to - from) * i) / n;
    out.push(axis === 'lat' ? [fixed, r6(v)] : [r6(v), fixed]);
  }
  return out;
}

function turnModifier(b1, b2) {
  let d = (((b2 - b1) % 360) + 360) % 360;
  if (d > 180) d -= 360;
  if (Math.abs(d) < 20) return 'straight';
  return d > 0 ? 'right' : 'left';
}

const brg = (a, b) => {
  const dLon = b[0] - a[0];
  const dLat = b[1] - a[1];
  return (
    ((Math.atan2(dLon * Math.cos((a[1] * Math.PI) / 180), dLat) * 180) / Math.PI + 360) %
    360
  );
};

/** One L-shaped route as an OSRM route object. */
function lRoute(a, b, latFirst, n) {
  const start = [r6(a.lon), r6(a.lat)];
  const g0 = [r6(snap(a.lon)), r6(snap(a.lat))];
  const g1 = [r6(snap(b.lon)), r6(snap(b.lat))];
  const corner = latFirst ? [g0[0], g1[1]] : [g1[0], g0[1]];
  const line = [start, g0];
  if (latFirst) {
    line.push(...walk(g0[1], corner[1], g0[0], 'lat'));
    line.push(...walk(corner[0], g1[0], corner[1], 'lon'));
  } else {
    line.push(...walk(g0[0], corner[0], g0[1], 'lon'));
    line.push(...walk(corner[1], g1[1], corner[0], 'lat'));
  }
  line.push([r6(b.lon), r6(b.lat)]);
  const len = (p, q) => haversineM(p[1], p[0], q[1], q[0]);
  const legLen = (pts) => pts.slice(1).reduce((t, p, i) => t + len(pts[i], p), 0);
  const i1 = line.findIndex((p) => p[0] === corner[0] && p[1] === corner[1]);
  const first = line.slice(0, Math.max(2, i1 + 1));
  const second = line.slice(Math.max(1, i1));
  const d1 = legLen(first);
  const d2 = legLen(second);
  const street = (k) => `Demo ${latFirst ? 'Avenue' : 'Street'} ${n * 10 + k}`;
  const steps = [
    {
      maneuver: { type: 'depart', location: start },
      name: street(1),
      distance: d1,
      duration: d1 / SPEED,
    },
    {
      maneuver: {
        type: 'turn',
        modifier: turnModifier(brg(first.at(-2), corner), brg(corner, second[1] ?? g1)),
        location: corner,
      },
      name: street(2),
      distance: d2,
      duration: d2 / SPEED,
    },
    {
      maneuver: { type: 'arrive', location: line.at(-1) },
      name: street(2),
      distance: 0,
      duration: 0,
    },
  ];
  const distance = d1 + d2;
  return {
    distance,
    duration: distance / SPEED,
    geometry: { type: 'LineString', coordinates: line },
    legs: [
      {
        summary: `${street(1)}, ${street(2)}`,
        steps,
        distance,
        duration: distance / SPEED,
      },
    ],
  };
}

function osrmAnswer(path) {
  const m = /\/route\/v1\/\w+\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)$/.exec(path);
  if (!m) return { code: 'InvalidQuery', routes: [] };
  const [lon1, lat1, lon2, lat2] = m.slice(1).map(Number);
  const a = { lat: lat1, lon: lon1 };
  const b = { lat: lat2, lon: lon2 };
  return { code: 'Ok', routes: [lRoute(a, b, true, 1), lRoute(a, b, false, 2)] };
}

function signalsAnswer(ql) {
  const elements = [];
  for (const m of String(ql).matchAll(
    /\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/g,
  )) {
    const [s, w, n, e] = m.slice(1).map(Number);
    for (let y = Math.ceil(s / GRID); y * GRID <= n && elements.length < 4000; y += 1)
      for (let x = Math.ceil(w / GRID); x * GRID <= e; x += 1)
        if ((((x + y) % 3) + 3) % 3 === 0)
          elements.push({
            type: 'node',
            id: elements.length + 1,
            lat: r6(y * GRID),
            lon: r6(x * GRID),
          });
  }
  return { elements };
}

function photonAnswer(params) {
  const q = String(params?.q ?? '');
  const features = searchPlaces(q, { limit: 3 }).map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
    properties: {
      name: p.name.split(', ')[0],
      country: p.name.split(', ')[1] ?? '',
      osm_key: 'place',
      osm_value: 'city',
    },
  }));
  const lat = Number(params?.lat);
  const lon = Number(params?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    [
      [0.012, 0.01],
      [-0.018, 0.022],
      [0.03, -0.025],
    ].forEach(([dy, dx], i) =>
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r6(lon + dx), r6(lat + dy)] },
        properties: {
          name: `${q.toUpperCase()} ${i + 1}`,
          street: `Demo Street ${i + 1}`,
          city: 'Demo City',
          osm_key: 'amenity',
          osm_value: 'demo',
        },
      }),
    );
  }
  return { type: 'FeatureCollection', features };
}

/** A proxy client with the real one's getJson signature. */
export function createNavMockProxy({ delayMs = 120 } = {}) {
  const later = (v) => new Promise((resolve) => setTimeout(() => resolve(v), delayMs));
  return {
    demo: true,
    async getJson(feed, path, { params } = {}) {
      if (feed === 'osrm') return later(osrmAnswer(path));
      if (feed === 'overpass') return later(signalsAnswer(params?.data));
      if (feed === 'photon') return later(photonAnswer(params));
      if (feed === 'nominatim' && path === '/reverse')
        return later({ name: '', address: { road: 'Demo Street', city: 'Demo City' } });
      throw notFound(feed);
    },
  };
}
