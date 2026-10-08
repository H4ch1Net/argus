// Solar position for readouts (the Intel HUD's SUN elevation). Pure: no
// Cesium, no DOM. The NOAA solar calculator equations (after Meeus,
// "Astronomical Algorithms"): good to about 0.01 degree in declination and a
// few seconds of time in the equation of time between 1800 and 2100, far
// inside the half-degree this is read at.
//
// Elevation is the apparent one (NOAA's refraction correction included), so
// sunrise reads about 0 at the moment the disc's centre clears the horizon.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Julian centuries since J2000.0 for a Date (UTC). */
function julianCentury(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  return (jd - 2451545) / 36525;
}

/** NOAA atmospheric refraction (degrees) for a geometric elevation. */
function refractionDeg(elev) {
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let arcsec;
  if (elev > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575)
    arcsec = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else arcsec = -20.774 / te;
  return arcsec / 3600;
}

/**
 * Sun position seen from a point on the ground.
 * @param {number} lat degrees, north positive
 * @param {number} lon degrees, east positive
 * @param {Date} [date] instant (default now)
 * @returns {{ elevation: number, azimuth: number, declination: number,
 *   equationOfTime: number, hourAngle: number }}
 *   elevation (apparent, degrees), azimuth (degrees clockwise from true
 *   north, 0..360), declination (degrees), equation of time (minutes), local
 *   hour angle (degrees, negative before solar noon)
 */
export function sunPosition(lat, lon, date = new Date()) {
  const T = julianCentury(date);
  const L0 = (((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289;
  const trueLong = L0 + C;
  const omega = (125.04 - 1934.136 * T) * RAD;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega);
  const meanObliq =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(omega);
  const decl = Math.asin(Math.sin(obliq * RAD) * Math.sin(appLong * RAD));

  const y = Math.tan((obliq / 2) * RAD) ** 2;
  const L0r = L0 * RAD;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr));

  // True solar time at the point, in minutes past local solar midnight.
  const msOfDay = ((date.getTime() % 86400000) + 86400000) % 86400000;
  const tst = (((msOfDay / 60000 + eqTime + 4 * lon) % 1440) + 1440) % 1440;
  const ha = tst / 4 - 180; // degrees, 0 at solar noon

  const phi = lat * RAD;
  const har = ha * RAD;
  const cosZen = Math.max(
    -1,
    Math.min(
      1,
      Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(har),
    ),
  );
  const geometric = 90 - Math.acos(cosZen) * DEG;
  const elevation = geometric + refractionDeg(geometric);
  // Azimuth from north, clockwise; atan2 keeps it defined at the equator.
  const az =
    Math.atan2(
      Math.sin(har),
      Math.cos(har) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi),
    ) *
      DEG +
    180;
  return {
    elevation,
    azimuth: ((az % 360) + 360) % 360,
    declination: decl * DEG,
    equationOfTime: eqTime,
    hourAngle: ha,
  };
}

/**
 * Apparent solar elevation in degrees (negative below the horizon).
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {Date} [date] instant (default now)
 */
export function sunElevationDeg(lat, lon, date = new Date()) {
  return sunPosition(lat, lon, date).elevation;
}

/**
 * Solar azimuth in degrees clockwise from true north (0..360).
 * @param {number} lat degrees
 * @param {number} lon degrees
 * @param {Date} [date] instant (default now)
 */
export function sunAzimuthDeg(lat, lon, date = new Date()) {
  return sunPosition(lat, lon, date).azimuth;
}
