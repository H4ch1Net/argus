// Storm forecast cones and centre tracks (NOAA NHC) as normalized entities for
// two Layer SDK layers: 'cyclonecones' (polygon renderType) and
// 'cyclonetracks' (polyline renderType). Pure: no Cesium, shared with the
// terminal shell.
//
// The source (source.js) returns { status, gis, demo? }: status is
// CurrentStorms.json and gis the [points, track, cone] GeoJSON collections, or
// null when the GIS service failed. Geometry is drawn only for storms that pass
// the advisory coherence gate (../cyclones/forecast.js).

import { parseCyclones } from '../cyclones/parse.js';
import { withForecastGeometry, coherentCycloneGeometry } from '../cyclones/forecast.js';
import { polygonParts, lineParts, ringCentroid, ringArea } from '../sdk/rings.js';

/** Storms from the raw payload, with forecast geometry where it is coherent. */
export function parseCycloneForecast(raw) {
  const status = raw?.status;
  const storms = parseCyclones(
    status ? { ...status, demo: Boolean(raw.demo || status.demo) } : null,
  );
  return withForecastGeometry(storms, raw?.gis);
}

// What every cone/track entity carries from its storm, for the card and search.
function stormMeta(storm) {
  const m = storm.meta;
  return {
    stormId: m.stormId,
    name: m.name,
    classification: m.classification,
    basin: m.basin,
    windKt: m.windKt,
    advisoryNumber: m.geometryAdvisoryNumber,
    advisoryUrl: m.advisoryUrl,
    lastUpdate: m.lastUpdate,
    forecastPoints: m.forecastPoints,
    demo: m.demo,
  };
}

/**
 * Cone polygons (one entity per polygon part, largest first). The advisory is
 * part of the id, so a new advisory replaces the shape instead of reshaping it.
 */
export function cycloneConeEntities(raw) {
  const out = [];
  for (const storm of parseCycloneForecast(raw)) {
    if (!coherentCycloneGeometry(storm)) continue;
    const parts = polygonParts(storm.meta.cone);
    if (!parts?.length) continue;
    parts.sort((a, b) => ringArea(b.outer) - ringArea(a.outer));
    parts.forEach((part, i) => {
      out.push({
        id: `nhccone:${storm.meta.stormId}:${storm.meta.geometryAdvisoryNumber}:${i}`,
        type: 'cyclone-cone',
        position: ringCentroid(part.outer),
        meta: { ...stormMeta(storm), polygon: part.outer, holes: part.holes, part: i },
      });
    });
  }
  return out;
}

/** Forecast centre tracks (one entity per line part), positioned at the start. */
export function cycloneTrackEntities(raw) {
  const out = [];
  for (const storm of parseCycloneForecast(raw)) {
    if (!coherentCycloneGeometry(storm)) continue;
    const parts = lineParts(storm.meta.track);
    if (!parts?.length) continue;
    parts.forEach((path, i) => {
      out.push({
        id: `nhctrack:${storm.meta.stormId}:${storm.meta.geometryAdvisoryNumber}:${i}`,
        type: 'cyclone-track',
        position: { longitude: path[0][0], latitude: path[0][1], altitude: 0 },
        meta: { ...stormMeta(storm), path, part: i },
      });
    });
  }
  return out;
}

/** A hint beside the count: why there is nothing to draw. */
export function forecastStatusNote(raw) {
  if (!raw) return '';
  if (!raw.status?.activeStorms?.length) return 'no active storms';
  const storms = parseCycloneForecast(raw);
  if (storms.some(coherentCycloneGeometry)) return '';
  if (storms.some((s) => s.meta.geometryStatus === 'unavailable'))
    return 'forecast geometry unavailable';
  return 'awaiting current-advisory geometry';
}
