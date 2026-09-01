// Parse a USGS earthquake GeoJSON FeatureCollection into normalized entities.
//
// USGS (verified Aug 2026) returns a FeatureCollection; each feature has an id,
// properties {mag, place, time, url, ...}, and geometry.coordinates ordered
// [longitude, latitude, depth_km] (depth, not elevation). Pure: no Cesium.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * @param {{ features?: any[] }} geojson
 * @returns {object[]} normalized entities
 */
export function parseQuakes(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const f of features) {
    const c = f?.geometry?.coordinates;
    if (!Array.isArray(c)) continue;
    const longitude = num(c[0]);
    const latitude = num(c[1]);
    if (longitude === null || latitude === null) continue;
    const p = f.properties || {};
    out.push({
      id: f.id,
      type: 'earthquake',
      // Quakes are surface events; the depth is metadata, not render altitude.
      position: { longitude, latitude, altitude: 0 },
      meta: {
        mag: num(p.mag),
        place: p.place || '',
        time: num(p.time),
        depthKm: num(c[2]),
        url: p.url || null,
      },
    });
  }
  return out;
}
