// Keyless place search via Photon (komoot's OSM geocoder) through the proxy
// feed 'photon'. Pure: query params and GeoJSON parsing.
//
// Adapted from gods-eye-view src/keylessGeocoder.js (MIT).
//
// Terms (per the reference implementation, not live-tested here): Photon's
// public instance at photon.komoot.io is a courtesy service on fair use (heavy
// use is throttled, no guarantee of availability); results are OpenStreetMap
// data under the ODbL. The proxy caches and rate-limits it, and only q, limit,
// lat and lon ever reach it.

export const PHOTON_FEED = 'photon';
export const PHOTON_PATH = '/api/';
export const PHOTON_LIMIT = 5;
export const PHOTON_ATTRIBUTION =
  'Place search: Photon by komoot, data © OpenStreetMap contributors (ODbL)';

/**
 * Proxy params for one query. `near` is a soft proximity bias (the view
 * centre), never a hard bbox: Photon's bbox filters, so a search for somewhere
 * off-screen would find nothing. Rounded to 0.1 degree so nearby views share
 * the proxy cache.
 * @param {string} query
 * @param {{ lat: number, lon: number } | null} [near]
 */
export function photonParams(query, near = null, limit = PHOTON_LIMIT) {
  const params = {
    q: String(query ?? '')
      .trim()
      .slice(0, 200),
    limit: Math.min(10, Math.max(1, Math.round(Number(limit) || PHOTON_LIMIT))),
  };
  const lat = Number(near?.lat ?? near?.latitude);
  const lon = Number(near?.lon ?? near?.longitude);
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
  ) {
    params.lat = Number(lat.toFixed(1));
    params.lon = Number(lon.toFixed(1));
  }
  return params;
}

/** "Name, District, City, State, Country" without repeats, as one line. */
export function photonLabel(props) {
  const parts = [];
  for (const field of ['name', 'district', 'city', 'state', 'country']) {
    const v = typeof props?.[field] === 'string' ? props[field].trim().slice(0, 80) : '';
    if (v && !parts.includes(v)) parts.push(v);
  }
  if (!props?.name) {
    // A street address has no name: lead with "street housenumber".
    const street = [props?.street, props?.housenumber]
      .filter((x) => typeof x === 'string' && x.trim())
      .join(' ')
      .slice(0, 80);
    if (street) parts.unshift(street);
  }
  return parts.join(', ');
}

/**
 * Photon GeoJSON FeatureCollection -> geocoder results (the shape
 * parseNominatim gives, plus the OSM class and a bbox when Photon has one).
 * Features without a usable point are skipped.
 * @returns {Array<{ name: string, latitude: number, longitude: number, kind: string|null,
 *   bbox: [number, number, number, number] | null, source: 'photon' }>}
 */
export function parsePhoton(json) {
  const features = Array.isArray(json?.features) ? json.features : [];
  const out = [];
  for (const f of features) {
    if (f?.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) continue;
    const [lon, lat] = f.geometry.coordinates.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const props = f.properties || {};
    const name = photonLabel(props);
    if (!name) continue;
    const key = typeof props.osm_key === 'string' ? props.osm_key : '';
    const value = typeof props.osm_value === 'string' ? props.osm_value : '';
    out.push({
      name,
      latitude: lat,
      longitude: lon,
      kind: key && value ? `${key}=${value}`.slice(0, 60) : null,
      bbox: extentToBbox(props.extent),
      source: 'photon',
    });
  }
  return out;
}

/**
 * Photon's extent is [west, north, east, south]; read naively as [w, s, e, n]
 * it gives an inverted box that still looks valid. Returns [west, south, east,
 * north] or null (antimeridian-wrapped extents are left out).
 */
export function extentToBbox(extent) {
  if (!Array.isArray(extent) || extent.length !== 4) return null;
  const [west, north, east, south] = extent.map(Number);
  if (![west, north, east, south].every(Number.isFinite)) return null;
  if (west > east) return null;
  if (Math.abs(north) > 90 || Math.abs(south) > 90) return null;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) return null;
  return [west, Math.min(north, south), east, Math.max(north, south)];
}
