import { ROAD_CLASSES, classesFor, hashString } from './roads.js';
import { createTrafficModel } from './source.js';

// Dev / demo stand-in for the simulated traffic: a procedural street grid
// (Overpass-shaped ways) wherever the view is, and demo congestion in TomTom's
// flowSegmentData shape, so the layer runs with no proxy and no keys. Every
// note says DEMO. Grid lines sit on fixed multiples of latitude and longitude,
// so the ways of neighbouring tiles meet at the same points and connect.

const STEP_LAT = 0.0016; // about 180 m
const STEP_LON = 0.0021;

const classForLine = (i) =>
  i % 48 === 0
    ? 'trunk'
    : i % 24 === 0
      ? 'primary'
      : i % 6 === 0
        ? 'secondary'
        : i % 3 === 0
          ? 'tertiary'
          : 'residential';
const LANES = { trunk: 4, primary: 4, secondary: 2, tertiary: 2, residential: 1 };
const SPEED = {
  trunk: '80',
  primary: '50',
  secondary: '50',
  tertiary: '40',
  residential: '30',
};

/** Overpass-shaped ways for one tile of a band. */
export function demoGridWays(band, tile) {
  const allowed = new Set(classesFor(band));
  const elements = [];
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  const latLines = [];
  for (let i = Math.ceil(tile.lamin / STEP_LAT); i * STEP_LAT <= tile.lamax; i += 1)
    latLines.push(i);
  const lonLines = [];
  for (let j = Math.ceil(tile.lomin / STEP_LON); j * STEP_LON <= tile.lomax; j += 1)
    lonLines.push(j);
  const way = (axis, idx, pts) => {
    const cls = classForLine(Math.abs(idx));
    if (!allowed.has(cls) || pts.length < 2) return;
    elements.push({
      type: 'way',
      id: hashString(`${axis}${idx}:${tile.key}`),
      geometry: pts.map(([lon, lat]) => ({ lat: r6(lat), lon: r6(lon) })),
      tags: {
        highway: cls,
        name: `DEMO ${axis === 'lat' ? 'ST' : 'AVE'} ${Math.abs(idx)}`,
        lanes: String(LANES[cls]),
        maxspeed: SPEED[cls],
        // Every other small street one way, alternating direction.
        ...(cls === 'residential' && idx % 2
          ? { oneway: idx % 4 === 1 ? 'yes' : '-1' }
          : {}),
      },
    });
  };
  for (const i of latLines) {
    const lat = i * STEP_LAT;
    const pts = [
      [tile.lomin, lat],
      ...lonLines.map((j) => [j * STEP_LON, lat]),
      [tile.lomax, lat],
    ];
    way('lat', i, dedupe(pts));
  }
  for (const j of lonLines) {
    const lon = j * STEP_LON;
    const pts = [
      [lon, tile.lamin],
      ...latLines.map((i) => [lon, i * STEP_LAT]),
      [lon, tile.lamax],
    ];
    way('lon', j, dedupe(pts));
  }
  return { elements, demo: true };
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) out.push(p);
  }
  return out;
}

/** Demo congestion for a sampled edge, in TomTom's flowSegmentData shape. */
export function demoFlowSegment(sample) {
  const e = sample.edgeRef;
  const h = hashString(String(e?.wayId ?? sample.edge)) % 100;
  const ratio =
    h < 55 ? 0.82 + (h % 10) / 60 : h < 82 ? 0.5 + (h % 10) / 50 : 0.15 + (h % 10) / 40;
  const free = ROAD_CLASSES[e?.cls]?.kmh ?? 50;
  const coords = [];
  if (e)
    for (let k = 0; k < e.coords.length; k += 2)
      coords.push([e.coords[k], e.coords[k + 1]]);
  return {
    flowSegmentData: {
      frc: `FRC${Math.min(6, e?.rank ?? 3)}`,
      currentSpeed: Math.round(free * ratio),
      freeFlowSpeed: free,
      currentTravelTime: 60,
      freeFlowTravelTime: Math.round(60 * ratio),
      confidence: 1,
      roadClosure: false,
      coordinates: {
        coordinate: coords.map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
      },
      demo: true,
    },
  };
}

/** @param {{ getView: () => object, tier?: string }} opts */
export function createSimTrafficMockSource({ getView, tier }) {
  const model = createTrafficModel({
    tier,
    demo: true,
    // Demo congestion costs nothing: colour most of the bigger roads.
    flowBudget: 40,
    fetchWays: async (band, tile) => demoGridWays(band, tile),
    fetchFlow: async (sample) => demoFlowSegment(sample),
  });
  const source = async () => model.update(getView());
  source.model = model;
  return source;
}
