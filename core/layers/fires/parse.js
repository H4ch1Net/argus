// Parse NASA FIRMS area-API CSV into normalized fire-detection entities.
//
// VIIRS CSV header (verified Aug 2026): latitude, longitude, bright_ti4, scan,
// track, acq_date, acq_time, satellite, instrument, confidence, version,
// bright_ti5, frp, daynight. We index by header name so column order changes
// are tolerated. Pure: no Cesium. FIRMS rows have no id, so we synthesize one
// from position + acquisition time.

const num = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

export function parseFires(csvText) {
  const lines = String(csvText || '')
    .trim()
    .split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map((h) => h.trim());
  const col = Object.fromEntries(header.map((h, i) => [h, i]));
  const at = (cols, name) => (col[name] != null ? cols[col[name]] : undefined);

  const out = [];
  for (let r = 1; r < lines.length; r += 1) {
    const cols = lines[r].split(',');
    const latitude = num(at(cols, 'latitude'));
    const longitude = num(at(cols, 'longitude'));
    if (latitude === null || longitude === null) continue;
    const acqDate = at(cols, 'acq_date');
    const acqTime = at(cols, 'acq_time');
    out.push({
      id: `${latitude.toFixed(4)},${longitude.toFixed(4)},${acqDate},${acqTime}`,
      type: 'fire',
      position: { longitude, latitude, altitude: 0 },
      meta: {
        frp: num(at(cols, 'frp')), // fire radiative power, MW
        brightness: num(at(cols, 'bright_ti4')),
        confidence: at(cols, 'confidence') ?? null,
        acqDate: acqDate ?? null,
        acqTime: acqTime ?? null,
        daynight: at(cols, 'daynight') ?? null,
      },
    });
  }
  return out;
}
