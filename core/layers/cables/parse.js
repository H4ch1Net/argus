// Submarine cables and their landing points, from TeleGeography's public
// submarine cable map GeoJSON (CC BY-NC-SA 3.0, attribution "TeleGeography,
// submarinecablemap.com"; non-commercial use). Fetched at run time through the
// proxy, never bundled. Pure.
//
// cable-geo.json: FeatureCollection of MultiLineString features with
// properties { id, name, color, feature_id }. A cable becomes one entity per
// line segment (a picked segment shows the cable's card).
// landing-point-geo.json: Point features with properties { id, name, is_tbd }.

const MAX_POINTS_PER_SEGMENT = 2000;

const text = (v, max = 120) =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
const lonLat = (c) =>
  Array.isArray(c) &&
  Number.isFinite(c[0]) &&
  Number.isFinite(c[1]) &&
  Math.abs(c[0]) <= 180 &&
  Math.abs(c[1]) <= 90;
const hexColor = (v) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);

function segmentsOf(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

/**
 * @param {{ features?: object[] }} geojson
 * @returns {object[]} normalized entities (type 'cable'), meta.path = [[lon, lat], ...]
 */
export function parseCables(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const f of features) {
    const p = f?.properties || {};
    const cableId = text(p.id, 80) || text(String(p.feature_id ?? ''), 80);
    if (!cableId) continue;
    segmentsOf(f.geometry).forEach((coords, i) => {
      const path = (Array.isArray(coords) ? coords : [])
        .filter(lonLat)
        .slice(0, MAX_POINTS_PER_SEGMENT)
        .map(([lon, lat]) => [lon, lat]);
      if (path.length < 2) return;
      const [longitude, latitude] = path[Math.floor(path.length / 2)];
      out.push({
        id: `cable:${cableId}:${i}`,
        type: 'cable',
        position: { longitude, latitude, altitude: 0 },
        meta: {
          cableId,
          name: text(p.name) || cableId,
          color: hexColor(p.color),
          path,
          demo: Boolean(geojson.demo),
        },
      });
    });
  }
  return out;
}

/**
 * @param {{ features?: object[] }} geojson
 * @returns {object[]} normalized entities (type 'cable-landing')
 */
export function parseLandingPoints(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const f of features) {
    const c = f?.geometry?.type === 'Point' ? f.geometry.coordinates : null;
    const id = text(String(f?.properties?.id ?? ''), 80);
    if (!id || !lonLat(c)) continue;
    out.push({
      id: `landing:${id}`,
      type: 'cable-landing',
      position: { longitude: c[0], latitude: c[1], altitude: 0 },
      meta: {
        landingId: id,
        name: text(f.properties.name) || id,
        tbd: Boolean(f.properties.is_tbd),
      },
    });
  }
  return out;
}
