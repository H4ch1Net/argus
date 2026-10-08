// Wildfire perimeters (NIFC WFIGS current interagency perimeters, an ArcGIS
// FeatureServer) as normalized polygon entities. Pure: no Cesium, shared with
// the terminal shell.
//
// Adapted from gods-eye-view server/providers/firePerimeters.js and
// src/layers/perimeters/records.js (MIT): the pinned query, paging while
// exceededTransferLimit, and per-feature validation (one degenerate incident,
// such as a tiny polygon generalized away to geometry:null, is skipped rather
// than blanking the layer).
//
// One entity per polygon part (largest first). The polygon renderType draws
// meta.polygon (outer ring) and meta.holes; position is the part's centroid.

import { polygonParts, ringArea, ringCentroid, capVertices } from '../sdk/rings.js';

/** Fields read from the service, nothing else (no names of people). */
export const WFIGS_OUT_FIELDS = Object.freeze([
  'poly_IncidentName',
  'attr_UniqueFireIdentifier',
  'attr_IncidentSize',
  'attr_PercentContained',
  'attr_POOState',
  'attr_IncidentTypeCategory',
  'attr_FireDiscoveryDateTime',
  'poly_DateCurrent',
  'attr_FireCause',
  'attr_FireBehaviorGeneral',
  'attr_TotalIncidentPersonnel',
  'attr_POOCounty',
  'attr_EstimatedCostToDate',
  'attr_IncidentComplexityLevel',
  'attr_CpxName',
]);

/** Sub-path under the proxy feed 'wfigs' (FeatureServer layer 0). */
export const WFIGS_PATH = '/0/query';
/** The service returns up to 2,000 features a page; a peak season needs more. */
export const WFIGS_MAX_PAGES = 5;
export const WFIGS_PAGE_SIZE = 2000;

/** Query parameters for one page (pinned the same way by the proxy). */
export function wfigsParams(offset = 0) {
  return {
    where: '1=1',
    outFields: WFIGS_OUT_FIELDS.join(','),
    // ~100 m generalization keeps a full season near 1 MB.
    maxAllowableOffset: '0.001',
    outSR: '4326',
    f: 'geojson',
    ...(offset > 0 ? { resultOffset: String(offset) } : {}),
  };
}

/** True when the service says more pages follow. */
export const exceededTransferLimit = (payload) =>
  payload?.exceededTransferLimit === true ||
  payload?.properties?.exceededTransferLimit === true;

const MAX_RING = 4000; // vertices per ring after the cap
const MAX_PARTS = 24; // polygon parts per incident
const MAX_VERTICES = 250_000; // across the whole snapshot

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f<>]/g;
const text = (v, max = 80) => {
  if (typeof v !== 'string') return null;
  const s = v.replace(UNSAFE, '').trim().slice(0, max);
  return s || null;
};
const pct = (v) => {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
};

/**
 * @param {{ features?: object[], demo?: boolean }} geojson  one page, or the
 *   pages' features merged
 * @returns {object[]} normalized entities (type 'fire-perimeter')
 */
export function parsePerimeters(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  const seen = new Set();
  let budget = MAX_VERTICES;
  for (const f of features) {
    const p = f?.properties;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const parts = polygonParts(f.geometry);
    if (!parts?.length) continue;
    const uid = text(p.attr_UniqueFireIdentifier, 64);
    const stableId = uid ?? (f.id == null || f.id === '' ? null : String(f.id));
    if (stableId === null || seen.has(stableId)) continue;
    seen.add(stableId);
    const meta = {
      incidentId: stableId,
      name: text(p.poly_IncidentName),
      acres: num(p.attr_IncidentSize),
      containedPct: pct(p.attr_PercentContained),
      state: text(p.attr_POOState, 8),
      category: text(p.attr_IncidentTypeCategory, 8),
      discoveredMs: num(p.attr_FireDiscoveryDateTime),
      updatedMs: num(p.poly_DateCurrent),
      cause: text(p.attr_FireCause, 40),
      behavior: text(p.attr_FireBehaviorGeneral, 40),
      personnel: num(p.attr_TotalIncidentPersonnel),
      county: text(p.attr_POOCounty, 40),
      costUsd: num(p.attr_EstimatedCostToDate),
      complexity: text(p.attr_IncidentComplexityLevel, 40),
      complexName: text(p.attr_CpxName),
      demo: Boolean(geojson.demo),
    };
    parts.sort((a, b) => ringArea(b.outer) - ringArea(a.outer));
    const kept = parts.slice(0, MAX_PARTS);
    kept.forEach((part, i) => {
      const outer = capVertices(part.outer, MAX_RING);
      const holes = part.holes
        .map((h) => capVertices(h, MAX_RING))
        .filter((h) => h.length >= 3);
      const cost = outer.length + holes.reduce((s, h) => s + h.length, 0);
      if (cost > budget) return;
      budget -= cost;
      out.push({
        id: i === 0 ? `wfigs:${stableId}` : `wfigs:${stableId}:${i}`,
        type: 'fire-perimeter',
        position: ringCentroid(outer),
        meta: { ...meta, polygon: outer, holes, part: i, parts: kept.length },
      });
    });
  }
  return out;
}
