// Official NHC forecast geometry for the active storms: the 5-day forecast
// points, centre track and cone from NOAA's NHC GIS MapServer (layers 5, 6
// and 7), attached to the storms parsed from CurrentStorms.json. Pure: no
// Cesium, shared by every shell.
//
// Adapted from gods-eye-view server/providers/cyclones.js (MIT):
// attachCycloneGeometry and its validators, and the coherence gate from
// src/layers/cyclones/rendering.js. Geometry is attached only when its
// advisory number matches both its own idp_source and the advisory the status
// feed reports, so older GIS geometry is never relabelled with a newer
// advisory. Any malformed payload rejects the whole set (the caller then
// shows storms without geometry), as the reference does.

/** The three GIS layers, as the reference project queries them. */
export const NHC_GIS_LAYERS = Object.freeze([
  Object.freeze({
    id: 5,
    kind: 'points',
    suffix: 'pts',
    count: 500,
    outFields: 'idp_source,advisnum,tau,maxwind,gust',
  }),
  Object.freeze({
    id: 6,
    kind: 'track',
    suffix: 'lin',
    count: 32,
    outFields: 'idp_source,advisnum',
  }),
  Object.freeze({
    id: 7,
    kind: 'cone',
    suffix: 'pgn',
    count: 32,
    outFields: 'idp_source,advisnum',
  }),
]);

/** Sub-path of a GIS layer's query under the proxy feed 'nhc-gis'. */
export const nhcGisPath = (layer) => `/${layer.id}/query`;

/** Query parameters for one GIS layer (pinned the same way by the proxy). */
export function nhcGisParams(layer) {
  return {
    where: '1=1',
    outFields: layer.outFields,
    outSR: '4326',
    resultRecordCount: String(layer.count),
    geometryPrecision: '4',
    f: 'geojson',
  };
}

const MAX_VERTICES = 25_000; // across all three layers
const MAX_LINE = 10_000;
const MAX_PARTS = 128;
const SOURCE = /^((?:al|ep|cp)\d{6})-(\d{1,3}[a-z]?)_5day_(pts|lin|pgn)$/i;

function invalid() {
  return new Error('invalid NHC forecast geometry');
}

/** '021' and 21 both become '21'; '7A' stays '7A'. Throws when malformed. */
export function normalizeAdvisory(value) {
  const s = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof s !== 'string' || !/^\d{1,3}[A-Z]?$/i.test(s)) throw invalid();
  return s.replace(/^0+(?=\d)/, '').toUpperCase();
}

function advisoryOrNull(value) {
  try {
    return normalizeAdvisory(value);
  } catch {
    return null;
  }
}

function number(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  if (!['string', 'number'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function position(coordinates) {
  if (
    !Array.isArray(coordinates) ||
    coordinates.length !== 2 ||
    !coordinates.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    Math.abs(coordinates[0]) > 180 ||
    Math.abs(coordinates[1]) > 90
  )
    throw invalid();
  return { longitude: coordinates[0], latitude: coordinates[1] };
}

function geometry(raw, kind, budget) {
  const types =
    kind === 'points'
      ? ['Point']
      : kind === 'track'
        ? ['LineString', 'MultiLineString']
        : ['Polygon', 'MultiPolygon'];
  if (!types.includes(raw?.type)) throw invalid();
  const point = (value) => {
    position(value);
    if (++budget.count > MAX_VERTICES) throw invalid();
    return [value[0], value[1]];
  };
  const line = (value, ring = false) => {
    if (!Array.isArray(value) || value.length < (ring ? 4 : 2) || value.length > MAX_LINE)
      throw invalid();
    const result = value.map(point);
    const [a, b] = [result[0], result[result.length - 1]];
    if (ring && (a[0] !== b[0] || a[1] !== b[1])) throw invalid();
    return result;
  };
  const list = (value, read) => {
    if (!Array.isArray(value) || !value.length || value.length > MAX_PARTS)
      throw invalid();
    return value.map(read);
  };
  const polygon = (value) => list(value, (ring) => line(ring, true));
  const coordinates =
    raw.type === 'Point'
      ? point(raw.coordinates)
      : raw.type === 'LineString'
        ? line(raw.coordinates)
        : raw.type === 'MultiLineString'
          ? list(raw.coordinates, (part) => line(part))
          : raw.type === 'Polygon'
            ? polygon(raw.coordinates)
            : list(raw.coordinates, polygon);
  return { type: raw.type, coordinates };
}

/**
 * Attach forecast geometry to parsed storms (core/layers/cyclones/parse.js
 * entities). Throws when any GIS payload is malformed.
 * @param {object[]} storms
 * @param {object[]} collections  [points, track, cone] GeoJSON FeatureCollections
 * @returns {object[]} new storm entities; meta gains geometryStatus
 *   ('current' | 'pending'), geometryAdvisoryNumber, forecastPoints
 *   [{ longitude, latitude, tauHours, windKt, gustKt }], track and cone
 *   (GeoJSON geometries) when coherent
 */
export function attachCycloneGeometry(storms, collections) {
  const budget = { count: 0 };
  const parsed = NHC_GIS_LAYERS.map((spec, index) => {
    const payload = collections?.[index];
    if (
      payload?.type !== 'FeatureCollection' ||
      payload.exceededTransferLimit ||
      payload.properties?.exceededTransferLimit ||
      !Array.isArray(payload.features) ||
      payload.features.length > spec.count
    )
      throw invalid();
    return payload.features.map((feature) => {
      if (feature?.type !== 'Feature') throw invalid();
      const p = feature.properties;
      const source = typeof p?.idp_source === 'string' && p.idp_source.match(SOURCE);
      if (!source || source[3].toLowerCase() !== spec.suffix) throw invalid();
      const adv = normalizeAdvisory(p.advisnum);
      if (adv !== normalizeAdvisory(source[2])) throw invalid();
      return {
        id: source[1].toLowerCase(),
        advisoryNumber: adv,
        geometry: geometry(feature.geometry, spec.kind, budget),
        tauHours: number(p.tau, 0, 168),
        windKt: number(p.maxwind, 0, 300),
        gustKt: number(p.gust, 0, 350),
      };
    });
  });
  return storms.map((storm) => {
    const advisory = advisoryOrNull(storm.meta?.advisoryNumber);
    const groups = parsed.map((items) =>
      items.filter(
        (item) =>
          advisory !== null &&
          item.id === storm.meta.stormId &&
          item.advisoryNumber === advisory,
      ),
    );
    if (groups[1].length > 1 || groups[2].length > 1) throw invalid();
    if (!groups[0].length || groups[1].length !== 1 || groups[2].length !== 1)
      return withMeta(storm, { geometryStatus: 'pending' });
    const taus = new Set();
    const forecastPoints = groups[0]
      .map((item) => {
        if (item.tauHours === null || taus.has(item.tauHours)) throw invalid();
        taus.add(item.tauHours);
        return {
          ...position(item.geometry.coordinates),
          tauHours: item.tauHours,
          windKt: item.windKt,
          gustKt: item.gustKt,
        };
      })
      .sort((a, b) => a.tauHours - b.tauHours);
    return withMeta(storm, {
      geometryStatus: 'current',
      geometryAdvisoryNumber: advisory,
      forecastPoints,
      track: groups[1][0].geometry,
      cone: groups[2][0].geometry,
    });
  });
}

const EMPTY = {
  geometryAdvisoryNumber: null,
  forecastPoints: [],
  track: null,
  cone: null,
};

function withMeta(storm, extra) {
  return { ...storm, meta: { ...storm.meta, ...EMPTY, ...extra } };
}

/**
 * attachCycloneGeometry that never throws: a missing or malformed GIS set
 * leaves every storm without geometry (geometryStatus 'unavailable').
 */
export function withForecastGeometry(storms, collections) {
  if (!storms.length) return storms;
  if (!Array.isArray(collections) || collections.some((c) => !c))
    return storms.map((s) => withMeta(s, { geometryStatus: 'unavailable' }));
  try {
    return attachCycloneGeometry(storms, collections);
  } catch {
    return storms.map((s) => withMeta(s, { geometryStatus: 'unavailable' }));
  }
}

/** Only geometry from the displayed status advisory is eligible for rendering. */
export function coherentCycloneGeometry(storm) {
  const m = storm?.meta;
  return (
    m?.geometryStatus === 'current' &&
    m.geometryAdvisoryNumber != null &&
    m.geometryAdvisoryNumber === advisoryOrNull(m.advisoryNumber)
  );
}
