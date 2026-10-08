// Traffic incidents from the TomTom Traffic Incident Details API (v5), pure:
// the query builder (shared with the proxy's pin in proxy/feeds/traffic.js)
// and the normalizer. No Cesium, no DOM: the terminal uses it too.
//
// Per the provider's documentation, not live-tested here: GET
// /traffic/services/5/incidentDetails?bbox=minLon,minLat,maxLon,maxLat
// &fields={...}&language=en-GB&timeValidityFilter=present, with the key added
// by the proxy (TOMTOM_API_KEY, server side). The answer is
// { incidents: [GeoJSON Feature] } whose geometry is a Point or a LineString
// (the affected stretch) and whose properties carry iconCategory,
// magnitudeOfDelay, events, from / to, length (m), delay (s), start / end
// times and road numbers. A bbox may cover at most 10,000 km2, so the view is
// clipped to an 80 km square around its centre when larger.

export const TOMTOM_INCIDENT_FIELDS =
  '{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,events{description,code,iconCategory},startTime,endTime,from,to,length,delay,roadNumbers,timeValidity}}}';
export const TOMTOM_INCIDENT_PATH = '/incidentDetails';
export const TOMTOM_MAX_BBOX_KM2 = 10_000;

const CLIP_KM = 80; // square side when the view is larger (snapping keeps it < 10,000 km2)
const SNAP = 0.05; // degrees: nearby views share one cached answer
const KM_PER_DEG = 111.32;
const MAX_PATH = 200; // vertices kept per affected stretch

const round5 = (v) => Math.round(v * 1e5) / 1e5;
const clampLon = (v) => Math.max(-180, Math.min(180, v));
const clampLat = (v) => Math.max(-85, Math.min(85, v));

/** Area of a lon/lat box in km2 (flat approximation at its middle latitude). */
export function bboxAreaKm2({ lomin, lamin, lomax, lamax }) {
  const mid = ((lamin + lamax) / 2) * (Math.PI / 180);
  return (
    Math.abs(lamax - lamin) *
    KM_PER_DEG *
    Math.abs(lomax - lomin) *
    KM_PER_DEG *
    Math.max(0.01, Math.cos(mid))
  );
}

/**
 * The box to ask for: the view snapped outward to a 0.05 degree grid, or an
 * 80 km square around the view centre when the view is larger than the API
 * allows (then `clipped` is true). Null without a usable view.
 */
export function incidentBox(bbox) {
  if (!bbox) return null;
  let { lomin, lamin, lomax, lamax } = bbox;
  if (![lomin, lamin, lomax, lamax].every(Number.isFinite)) return null;
  if (lomax < lomin) lomax += 360; // across the antimeridian
  const snap = (box) => ({
    lomin: clampLon(round5(Math.floor(box.lomin / SNAP) * SNAP)),
    lamin: clampLat(round5(Math.floor(box.lamin / SNAP) * SNAP)),
    lomax: clampLon(round5(Math.ceil(box.lomax / SNAP) * SNAP)),
    lamax: clampLat(round5(Math.ceil(box.lamax / SNAP) * SNAP)),
  });
  let snapped = snap({ lomin, lamin, lomax, lamax });
  let clipped = false;
  // Larger than the API allows once snapped: the square around the centre.
  if (lomax - lomin > 10 || bboxAreaKm2(snapped) > TOMTOM_MAX_BBOX_KM2 * 0.95) {
    const cLat = clampLat((lamin + lamax) / 2);
    let cLon = (lomin + lomax) / 2;
    if (cLon > 180) cLon -= 360;
    const dLat = CLIP_KM / 2 / KM_PER_DEG;
    const dLon = dLat / Math.max(0.05, Math.cos((cLat * Math.PI) / 180));
    snapped = snap({
      lomin: cLon - dLon,
      lamin: cLat - dLat,
      lomax: cLon + dLon,
      lamax: cLat + dLat,
    });
    clipped = true;
  }
  if (snapped.lomax <= snapped.lomin || snapped.lamax <= snapped.lamin) return null;
  return { ...snapped, clipped };
}

/** Query params for the proxy's 'tomtom-incidents' feed (no key: the proxy adds it). */
export function incidentQuery(bbox) {
  const b = incidentBox(bbox);
  if (!b) return null;
  return {
    bbox: `${b.lomin},${b.lamin},${b.lomax},${b.lamax}`,
    fields: TOMTOM_INCIDENT_FIELDS,
    language: 'en-GB',
    timeValidityFilter: 'present',
  };
}

// iconCategory -> kind (TomTom's documented list; 12 and 13 are unassigned).
const KIND_BY_ICON = {
  0: 'hazard',
  1: 'accident',
  2: 'weather', // fog
  3: 'hazard', // dangerous conditions
  4: 'weather', // rain
  5: 'weather', // ice
  6: 'jam',
  7: 'closure', // lane closed
  8: 'closure', // road closed
  9: 'roadworks',
  10: 'weather', // wind
  11: 'weather', // flooding
  14: 'hazard', // broken-down vehicle
};
export const TOMTOM_ICON_LABELS = {
  0: 'Unknown',
  1: 'Accident',
  2: 'Fog',
  3: 'Dangerous conditions',
  4: 'Rain',
  5: 'Ice',
  6: 'Jam',
  7: 'Lane closed',
  8: 'Road closed',
  9: 'Road works',
  10: 'Wind',
  11: 'Flooding',
  14: 'Broken-down vehicle',
};
export const TOMTOM_DELAY_LABELS = ['Unknown', 'Minor', 'Moderate', 'Major', 'Indefinite'];

const text = (v, n = 120) =>
  typeof v === 'string' || typeof v === 'number'
    ? String(v)
        .replace(/\p{Cc}/gu, ' ')
        .trim()
        .slice(0, n)
    : '';
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const time = (v) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const lonLat = (c) =>
  Array.isArray(c) &&
  Number.isFinite(c[0]) &&
  Number.isFinite(c[1]) &&
  Math.abs(c[0]) <= 180 &&
  Math.abs(c[1]) <= 90
    ? [c[0], c[1]]
    : null;

/** 'critical' | 'notable' | 'minor' for a TomTom incident. */
export function tomtomSeverity(icon, magnitude) {
  if (icon === 8 || magnitude === 3) return 'critical';
  if (icon === 1) return magnitude >= 2 ? 'critical' : 'notable';
  if (magnitude === 2 || magnitude === 4 || icon === 7) return 'notable';
  return 'minor';
}

/** At most MAX_PATH vertices, keeping both ends. */
function thin(path) {
  if (path.length <= MAX_PATH) return path;
  const step = (path.length - 1) / (MAX_PATH - 1);
  return Array.from({ length: MAX_PATH }, (_, i) => path[Math.round(i * step)]);
}

/** TomTom incidentDetails answer -> normalized incident entities. */
export function parseTomTomIncidents(json) {
  const list = Array.isArray(json?.incidents) ? json.incidents : [];
  const out = [];
  const seen = new Set();
  for (const f of list) {
    const p = f?.properties ?? {};
    const g = f?.geometry ?? {};
    let path = null;
    let at = null;
    if (g.type === 'Point') at = lonLat(g.coordinates);
    else if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
      const pts = g.coordinates.map(lonLat).filter(Boolean);
      if (pts.length) {
        at = pts[Math.floor(pts.length / 2)];
        if (pts.length > 1) path = thin(pts);
      }
    }
    if (!at) continue;
    const id = text(p.id, 80) || `${at[0].toFixed(5)},${at[1].toFixed(5)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const icon = Number.isInteger(p.iconCategory) ? p.iconCategory : 0;
    const magnitude = Number.isInteger(p.magnitudeOfDelay) ? p.magnitudeOfDelay : 0;
    const events = (Array.isArray(p.events) ? p.events : [])
      .map((e) => text(e?.description, 120))
      .filter(Boolean)
      .slice(0, 4);
    out.push({
      id: `tomtom/${id}`,
      type: 'incident',
      position: { longitude: at[0], latitude: at[1], altitude: 0 },
      meta: {
        source: 'tomtom',
        kind: KIND_BY_ICON[icon] ?? 'hazard',
        icon,
        magnitude,
        severity: tomtomSeverity(icon, magnitude),
        delayS: num(p.delay),
        lengthM: num(p.length),
        from: text(p.from),
        to: text(p.to),
        roads: (Array.isArray(p.roadNumbers) ? p.roadNumbers : [])
          .map((r) => text(r, 16))
          .filter(Boolean)
          .slice(0, 4),
        events,
        startMs: time(p.startTime),
        endMs: time(p.endTime),
        path,
        // Only the dev stand-in sets this (core/layers/incidents/source.js).
        demo: p.demo === true,
      },
    });
  }
  return out;
}
