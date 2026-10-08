// Active tropical cyclones from NOAA NHC's CurrentStorms.json. Pure.
//
// Each activeStorms[] entry: id ('al'|'ep'|'cp' + 6 digits), name,
// classification (TD, TS, HU, ...), latitudeNumeric / longitudeNumeric,
// intensity (kt, as a string), pressure (hPa), movementDir (deg),
// movementSpeed (kt, as the reference project reads it), lastUpdate (ISO), and
// forecastAdvisory { advNum, issuance, url }. Field handling follows the
// reference project's parser (server/providers/cyclones.js).

const num = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};
const text = (v, max = 80) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const nhcLink = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'www.nhc.noaa.gov' ? u.href : null;
  } catch {
    return null;
  }
};

const BASIN = { al: 'Atlantic', ep: 'Eastern Pacific', cp: 'Central Pacific' };

/**
 * @param {{ activeStorms?: object[] }} payload
 * @returns {object[]} normalized entities (type 'cyclone')
 */
export function parseCyclones(payload) {
  const storms = Array.isArray(payload?.activeStorms) ? payload.activeStorms : [];
  const out = [];
  for (const s of storms.slice(0, 32)) {
    if (typeof s?.id !== 'string' || !/^(al|ep|cp)\d{6}$/i.test(s.id)) continue;
    const latitude = num(s.latitudeNumeric);
    const longitude = num(s.longitudeNumeric);
    if (latitude === null || longitude === null) continue;
    const id = s.id.toLowerCase();
    out.push({
      id: `nhc:${id}`,
      type: 'cyclone',
      position: { longitude, latitude, altitude: 0 },
      meta: {
        stormId: id,
        name: text(s.name) || id.toUpperCase(),
        classification: text(s.classification, 8),
        basin: BASIN[id.slice(0, 2)],
        windKt: num(s.intensity),
        pressureHpa: num(s.pressure),
        movementDir: num(s.movementDir),
        movementKt: num(s.movementSpeed),
        lastUpdate: text(s.lastUpdate, 40),
        advisoryNumber: text(s.forecastAdvisory?.advNum, 8),
        advisoryUrl: nhcLink(s.forecastAdvisory?.url),
        demo: Boolean(payload?.demo),
      },
    });
  }
  return out;
}
