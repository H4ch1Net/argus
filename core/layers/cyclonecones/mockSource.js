// Dev / demo-only storm forecasts: the simulated storms of the cyclones mock,
// each given an advisory and NHC-GIS-shaped forecast points, centre track and
// cone, so the cone and track layers work offline or out of season. The cone
// is the hull of circles that grow with lead time (radii close to NHC's recent
// Atlantic cone sizes), which is how the official cone is built.

import { createCycloneMockSource } from '../cyclones/mockSource.js';

const ADVISORY = '7';
const TAUS = [0, 12, 24, 36, 48, 72, 96, 120];
const RADIUS_NM = { 0: 8, 12: 26, 24: 40, 36: 53, 48: 66, 72: 92, 96: 137, 120: 200 };

const rad = (d) => (d * Math.PI) / 180;

// Dead reckoning: nm along a heading from a point (fine away from the poles).
function move([lon, lat], headingDeg, nm) {
  const dLat = (nm * Math.cos(rad(headingDeg))) / 60;
  const dLon = (nm * Math.sin(rad(headingDeg))) / (60 * Math.cos(rad(lat)));
  return [lon + dLon, lat + dLat];
}

function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const round4 = ([lon, lat]) => [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4];
const feature = (props, geometry) => ({ type: 'Feature', properties: props, geometry });
const collection = (features) => ({ type: 'FeatureCollection', features });

/** NHC-GIS-shaped [points, track, cone] collections for one simulated storm. */
export function forecastGeometryFor(storm, advisory = ADVISORY) {
  const start = [storm.longitudeNumeric, storm.latitudeNumeric];
  const speed = Number(storm.movementSpeed) || 10;
  const wind0 = Number(storm.intensity) || 50;
  const source = (kind) => `${storm.id}-${advisory.padStart(3, '0')}_5day_${kind}`;
  const centres = TAUS.map((tau) =>
    // A gentle clockwise turn with time, as recurving storms do.
    move(start, (Number(storm.movementDir) || 300) + tau * 0.3, speed * tau),
  );
  const winds = TAUS.map((tau) =>
    Math.max(
      25,
      Math.round((wind0 + (tau <= 72 ? tau / 2.4 : 30 - (tau - 72) / 2)) / 5) * 5,
    ),
  );
  const points = collection(
    TAUS.map((tau, i) =>
      feature(
        {
          idp_source: source('pts'),
          advisnum: advisory,
          tau,
          maxwind: winds[i],
          gust: Math.round((winds[i] * 1.25) / 5) * 5,
        },
        { type: 'Point', coordinates: round4(centres[i]) },
      ),
    ),
  );
  const track = collection([
    feature(
      { idp_source: source('lin'), advisnum: advisory },
      { type: 'LineString', coordinates: centres.map(round4) },
    ),
  ]);
  const circles = TAUS.flatMap((tau, i) =>
    Array.from({ length: 36 }, (_, k) => move(centres[i], k * 10, RADIUS_NM[tau])),
  );
  const ring = hull(circles).map(round4);
  const cone = collection([
    feature(
      { idp_source: source('pgn'), advisnum: advisory },
      { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
    ),
  ]);
  return [points, track, cone];
}

export function createCycloneForecastMockSource() {
  const statusSource = createCycloneMockSource();
  return async () => {
    const status = await statusSource();
    const storms = status.activeStorms.map((s) => ({
      ...s,
      forecastAdvisory: { advNum: ADVISORY.padStart(3, '0') },
    }));
    const sets = storms.map((s) => forecastGeometryFor(s));
    const gis = [0, 1, 2].map((i) => collection(sets.flatMap((set) => set[i].features)));
    return { demo: true, status: { ...status, activeStorms: storms }, gis };
  };
}
