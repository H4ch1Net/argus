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
    });
  }
  return { time: num(payload?.time), aircraft };
}
