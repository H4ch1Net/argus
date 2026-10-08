import { parseTle } from './tle.js';
import { toSatrec, satPositionAt } from './propagate.js';

// Satellite normalization + card. No Cesium (satellite.js only), shared by the
// globe layer and the terminal shell. Positions are computed from orbital
// elements (SGP4), so the normalized position is just the epoch-now snapshot;
// callers propagate to their own clock with satPositionAt.

/** TLE text -> normalized satellites, each carrying its satrec for propagation. */
export function tleToNormalized(tleText, now = new Date()) {
  return parseTle(tleText).map((sat) => {
    const satrec = toSatrec(sat);
    const p = satPositionAt(satrec, now);
    return {
      id: String(satrec.satnum),
      type: 'satellite',
      position: p || { longitude: 0, latitude: 0, altitude: 0 },
      meta: { name: sat.name, satrec },
    };
  });
}

export function describeSatellite(n, now = new Date()) {
  const p = satPositionAt(n.meta.satrec, now);
  return {
    id: n.id,
    title: n.meta.name || `SAT ${n.id}`,
    subtitle: `NORAD ${n.id}`,
    rows: [
      ['Altitude', p ? `${Math.round(p.altitude / 1000)} km` : '—'],
      ['Latitude', p ? p.latitude.toFixed(2) : '—'],
      ['Longitude', p ? p.longitude.toFixed(2) : '—'],
    ],
  };
}

export const satelliteSearchText = (n) => `${n.meta.name} ${n.id}`;
