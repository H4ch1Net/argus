import * as satellite from 'satellite.js';

// SGP4 propagation wrappers around satellite.js. Pure JS (no Cesium), so these
// are unit-testable in Node. GMST realignment (satellite.gstime at the sample
// time) keeps ground positions correct as the Earth rotates.

/** Build a satrec from a TLE record. */
export function toSatrec(sat) {
  return satellite.twoline2satrec(sat.line1, sat.line2);
}

/**
 * Geodetic position of a satellite at a given date.
 * @returns {{ longitude: number, latitude: number, altitude: number } | null}
 *          degrees / degrees / metres, or null if propagation failed (decayed).
 */
export function satPositionAt(satrec, date) {
  if (!satrec || satrec.error) return null;
  const pv = satellite.propagate(satrec, date);
  const eci = pv && pv.position;
  if (!eci || Number.isNaN(eci.x)) return null;

  const gmst = satellite.gstime(date);
  const geo = satellite.eciToGeodetic(eci, gmst);
  const longitude = satellite.degreesLong(geo.longitude);
  const latitude = satellite.degreesLat(geo.latitude);
  const altitude = geo.height * 1000; // km -> m
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(altitude)
  ) {
    return null;
  }
  return { longitude, latitude, altitude };
}

/**
 * Sample one orbital period from `fromDate` for the orbit ring. satrec.no is the
 * mean motion in radians/minute, so the period is 2*pi / no minutes.
 * @returns {{ longitude: number, latitude: number, altitude: number }[]}
 */
export function orbitTrack(satrec, fromDate, samples = 90) {
  if (!satrec || !(satrec.no > 0)) return [];
  const periodMs = ((2 * Math.PI) / satrec.no) * 60 * 1000;
  const out = [];
  for (let i = 0; i <= samples; i += 1) {
    const p = satPositionAt(
      satrec,
      new Date(fromDate.getTime() + periodMs * (i / samples)),
    );
    if (p) out.push(p);
  }
  return out;
}
