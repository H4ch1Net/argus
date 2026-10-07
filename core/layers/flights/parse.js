// Parse an OpenSky /states/all response into normalized aircraft.
//
// OpenSky (verified Aug 2026) returns { time, states: [ [18 fields], ... ] }.
// Field order (index): 0 icao24, 1 callsign, 2 origin_country, 3 time_position,
// 4 last_contact, 5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground,
// 9 velocity, 10 true_track, 11 vertical_rate, 12 sensors, 13 geo_altitude,
// 14 squawk, 15 spi, 16 position_source, 17 category.
//
// Pure: no Cesium, no network. Aircraft with no position are dropped.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {{ time?: number, states?: any[][] }} payload
 * @returns {{ time: number|null, aircraft: object[] }}
 */
export function parseStates(payload) {
  const states = Array.isArray(payload?.states) ? payload.states : [];
  // Demo payloads (the dev mock) say so, and the card shows it: never "OpenSky".
  const source = payload?.demo ? 'demo (simulated)' : 'OpenSky';
  const aircraft = [];
  for (const s of states) {
    if (!Array.isArray(s)) continue;
    const longitude = num(s[5]);
    const latitude = num(s[6]);
    if (longitude === null || latitude === null) continue; // no position fix
    aircraft.push({
      id: s[0],
      callsign: typeof s[1] === 'string' ? s[1].trim() : '',
      originCountry: s[2] ?? null,
      timePosition: num(s[3]), // seconds since epoch
      longitude,
      latitude,
      baroAltitude: num(s[7]), // metres
      onGround: Boolean(s[8]),
      velocity: num(s[9]), // m/s
      trueTrack: num(s[10]), // degrees clockwise from north
      verticalRate: num(s[11]), // m/s
      geoAltitude: num(s[13]), // metres
      source,
    });
  }
  return { time: num(payload?.time), aircraft };
}

// adsb.lol (keyless fallback when no OpenSky client is configured). Its v2 API
// follows the ADSBExchange / readsb JSON schema: { ac: [...], now }, with
// aviation units (feet, knots, ft/min) and alt_baro === 'ground' on the ground.
// Converted here to the same SI aircraft shape as parseStates, so the rest of
// the layer (interpolation, card, search) cannot tell the sources apart.
// Terms note: the public API is keyless at the time of writing, with a
// feeder-issued key announced for the future; re-check before relying on it.

const FT_TO_M = 0.3048;
const KT_TO_MPS = 0.514444;
const FPM_TO_MPS = 0.00508;

/**
 * @param {{ ac?: object[], now?: number }} payload
 * @returns {{ time: number|null, aircraft: object[] }}
 */
export function parseAdsb(payload) {
  const list = Array.isArray(payload?.ac) ? payload.ac : [];
  const aircraft = [];
  for (const a of list) {
    if (!a || typeof a.hex !== 'string') continue;
    const longitude = num(a.lon);
    const latitude = num(a.lat);
    if (longitude === null || latitude === null) continue;
    const onGround = a.alt_baro === 'ground';
    const baroFt = num(a.alt_baro);
    const geomFt = num(a.alt_geom);
    const rateFpm = num(a.baro_rate) ?? num(a.geom_rate);
    aircraft.push({
      id: a.hex.replace(/^~/, '').toLowerCase(),
      callsign: typeof a.flight === 'string' ? a.flight.trim() : '',
      originCountry: null,
      registration: typeof a.r === 'string' ? a.r : null,
      typeCode: typeof a.t === 'string' ? a.t : null,
      squawk: typeof a.squawk === 'string' ? a.squawk : null,
      timePosition: null,
      longitude,
      latitude,
      baroAltitude: onGround ? 0 : baroFt === null ? null : baroFt * FT_TO_M,
      onGround,
      velocity: num(a.gs) === null ? null : a.gs * KT_TO_MPS,
      trueTrack: num(a.track) ?? num(a.true_heading),
      verticalRate: rateFpm === null ? null : rateFpm * FPM_TO_MPS,
      geoAltitude: geomFt === null ? null : geomFt * FT_TO_M,
      source: 'adsb.lol',
    });
  }
  const now = num(payload?.now);
  return { time: now === null ? null : Math.round(now / 1000), aircraft };
}

/** Parse either feed: adsb.lol ({ ac }) or OpenSky ({ states }). */
export function parseFlights(payload) {
  return Array.isArray(payload?.ac) ? parseAdsb(payload) : parseStates(payload);
}

// adsb.lol's point query takes a centre and a radius in nautical miles (capped
// at 250). Pick the centre of the viewport bbox and a radius that covers it.
const NM_PER_DEG_LAT = 60;
export const ADSB_MAX_RADIUS_NM = 250;

/**
 * @param {{ lamin: number, lomin: number, lamax: number, lomax: number }} bbox
 * @returns {{ latitude: number, longitude: number, radiusNm: number }}
 */
export function bboxToPointQuery(bbox) {
  const latitude = (bbox.lamin + bbox.lamax) / 2;
  const longitude = (bbox.lomin + bbox.lomax) / 2;
  const halfLatNm = ((bbox.lamax - bbox.lamin) / 2) * NM_PER_DEG_LAT;
  const halfLonNm =
    ((bbox.lomax - bbox.lomin) / 2) *
    NM_PER_DEG_LAT *
    Math.cos((latitude * Math.PI) / 180);
  const radiusNm = Math.min(
    ADSB_MAX_RADIUS_NM,
    Math.max(5, Math.ceil(Math.hypot(halfLatNm, halfLonNm))),
  );
  return {
    latitude: +latitude.toFixed(4),
    longitude: +longitude.toFixed(4),
    radiusNm,
  };
}

/** The adsb.lol sub-path for a viewport bbox. */
export function adsbPointPath(bbox) {
  const q = bboxToPointQuery(bbox);
  return `/v2/point/${q.latitude}/${q.longitude}/${q.radiusNm}`;
}
