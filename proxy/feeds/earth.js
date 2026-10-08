// Feed registry, Earth and weather: storms, fires, perimeters, dams.
// Same Feed shape as proxy/feeds.js (see its typedefs); spread into that list.
//
// Endpoints and parameters below are as the reference project
// (bilawalsidhu/gods-eye-view) uses them; egress was blocked when they were
// added, so each is "per the reference implementation, not live-tested here".
// Re-check terms before relying on one. (Dams need no feed of their own: they
// come through the existing 'overpass' feed.)

import { UA, exactPath, MINUTE, HOUR } from './common.js';

const matches = (rule, v) =>
  typeof rule === 'string'
    ? v === rule
    : rule instanceof RegExp
      ? rule.test(v)
      : Array.isArray(rule)
        ? rule.includes(v)
        : Boolean(rule(v));

/**
 * An allowQuery accepting exactly these parameters: every `required` key once,
 * any `optional` key at most once, nothing else. A rule is a fixed value, a
 * list of values, a RegExp or a predicate. ArcGIS REST endpoints serve other
 * formats and operations from the same path (f=html, returnIdsOnly, ...), so
 * the whole query is pinned, not just the path.
 */
export function pinnedQuery(required, optional = {}) {
  return (q) => {
    const keys = [...q.keys()];
    if (new Set(keys).size !== keys.length) return false;
    for (const k of Object.keys(required)) if (!q.has(k)) return false;
    for (const [k, v] of q) {
      const rule = Object.hasOwn(required, k)
        ? required[k]
        : Object.hasOwn(optional, k)
          ? optional[k]
          : null;
      if (rule === null || !matches(rule, v)) return false;
    }
    return true;
  };
}

const intUpTo = (max) => (v) => /^\d{1,6}$/.test(v) && Number(v) <= max;

// NHC GIS (core/layers/cyclones/forecast.js NHC_GIS_LAYERS asks exactly these).
const NHC_GIS_BASE =
  'https://mapservices.weather.noaa.gov/tropical/rest/services/tropical/NHC_tropical_weather_summary/MapServer';

// WFIGS fields (core/layers/perimeters/parse.js WFIGS_OUT_FIELDS, kept equal by
// proxy/test/earthFeeds.test.js). No field names a person.
export const WFIGS_OUT_FIELDS = [
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
].join(',');
const WFIGS_BASE =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer';

/** @type {import('../feeds.js').Feed[]} */
export const feeds = [
  {
    // NHC 5-day forecast geometry: layer 5 forecast points, 6 centre track,
    // 7 cone (NOAA NWS MapServer). Keyless, US public domain (NWS terms).
    // Per the reference implementation, not live-tested here.
    id: 'nhc-gis',
    baseUrl: NHC_GIS_BASE,
    methods: ['GET'],
    allowPaths: [
      /^\/tropical\/rest\/services\/tropical\/NHC_tropical_weather_summary\/MapServer\/[567]\/query$/,
    ],
    allowQuery: pinnedQuery(
      {
        where: '1=1',
        outFields: ['idp_source,advisnum', 'idp_source,advisnum,tau,maxwind,gust'],
        outSR: '4326',
        f: 'geojson',
      },
      { resultRecordCount: intUpTo(500), geometryPrecision: /^[0-6]$/ },
    ),
    headers: UA,
    governor: { ratePerMinute: 30 },
    cache: { ttlMs: 5 * MINUTE, staleMs: 12 * HOUR },
  },
  {
    // Current wildfire perimeters (NIFC WFIGS interagency, ArcGIS
    // FeatureServer). Keyless, US public domain. Generalized to ~100 m and
    // paged by resultOffset (at most 5 pages of 2,000). The reference project's
    // InciWeb lookup is an undocumented POST and is not ported.
    // Per the reference implementation, not live-tested here.
    id: 'wfigs',
    baseUrl: WFIGS_BASE,
    methods: ['GET'],
    allowPaths: [exactPath(`${new URL(WFIGS_BASE).pathname}/0/query`)],
    allowQuery: pinnedQuery(
      {
        where: '1=1',
        outFields: WFIGS_OUT_FIELDS,
        maxAllowableOffset: '0.001',
        outSR: '4326',
        f: 'geojson',
      },
      { resultOffset: intUpTo(10_000) },
    ),
    headers: UA,
    governor: { ratePerMinute: 20 },
    cache: { ttlMs: 5 * MINUTE, staleMs: HOUR },
  },
];
