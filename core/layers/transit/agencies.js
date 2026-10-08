// Transit agencies with keyless GTFS-Realtime vehicle positions, each reached
// through its own proxy feed (proxy/feeds.js). Coverage is a centre and radius,
// as the reference project models it; a feed is fetched only when the view
// overlaps its area, so panning around Boston never downloads Norway. Pure.

/**
 * @typedef {{ feedId: string, path: string, name: string, region: string,
 *   center: [number, number], radiusKm: number, license?: string }} TransitAgency
 */

/** @type {TransitAgency[]} */
export const TRANSIT_AGENCIES = [
  {
    feedId: 'gtfsrt-mbta',
    path: '/VehiclePositions.pb',
    name: 'MBTA',
    region: 'Boston',
    center: [42.3601, -71.0589],
    radiusKm: 70,
  },
  {
    feedId: 'gtfsrt-capmetro',
    path: '/application%2Foctet-stream',
    name: 'CapMetro',
    region: 'Austin',
    center: [30.2672, -97.7431],
    radiusKm: 60,
  },
  {
    feedId: 'gtfsrt-metrotransit',
    path: '/vehiclepositions.pb',
    name: 'Metro Transit',
    region: 'Minneapolis-St Paul',
    center: [44.9778, -93.265],
    radiusKm: 70,
  },
  {
    feedId: 'gtfsrt-hsl',
    path: '/hsl',
    name: 'HSL',
    region: 'Helsinki',
    center: [60.1699, 24.9384],
    radiusKm: 70,
    license: 'CC BY 4.0',
  },
  {
    feedId: 'gtfsrt-ovapi',
    path: '/vehiclePositions.pb',
    name: 'OVapi',
    region: 'Netherlands',
    center: [52.2, 5.3],
    radiusKm: 220,
  },
  {
    feedId: 'gtfsrt-entur',
    path: '/vehicle-positions',
    name: 'Entur',
    region: 'Norway',
    center: [64.0, 11.5],
    radiusKm: 720,
    license: 'NLOD',
  },
  {
    feedId: 'gtfsrt-translink',
    path: '/VehiclePositions',
    name: 'TransLink',
    region: 'South East Queensland',
    center: [-27.4698, 153.0251],
    radiusKm: 150,
    license: 'CC BY 4.0',
  },
];

const KM_PER_DEG = 111.32;
/** Views wider than this (degrees of latitude) skip transit: too much to show. */
export const TRANSIT_MAX_SPAN_DEG = 20;

/**
 * Agencies whose coverage overlaps the view (with a little slack).
 * @param {{ lamin: number, lomin: number, lamax: number, lomax: number }|undefined} bbox
 * @returns {{ agencies: TransitAgency[], tooWide: boolean }}
 */
export function agenciesInView(bbox, agencies = TRANSIT_AGENCIES, slackKm = 40) {
  if (!bbox) return { agencies: [], tooWide: false };
  if (bbox.lamax - bbox.lamin > TRANSIT_MAX_SPAN_DEG)
    return { agencies: [], tooWide: true };
  const hits = agencies.filter((a) => {
    const [lat, lon] = a.center;
    const r = a.radiusKm + slackKm;
    const dLat = r / KM_PER_DEG;
    const dLon = r / (KM_PER_DEG * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    return (
      lat - dLat <= bbox.lamax &&
      lat + dLat >= bbox.lamin &&
      lon - dLon <= bbox.lomax &&
      lon + dLon >= bbox.lomin
    );
  });
  return { agencies: hits, tooWide: false };
}
