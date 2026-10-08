// The public traffic camera nearest a point (the view centre, or "Around Me"),
// for a "nearest camera" button. Pure. Accepts the catalogue records
// ({ lat, lon }) or normalized entities ({ position: { latitude, longitude } }).
//
// GUARDRAIL: this picks a published camera by distance only; nothing here looks
// at, analyses or tracks what a camera sees.

const R_KM = 6371.0088;
const RAD = Math.PI / 180;

function latLonOf(c) {
  const lat = Number(c?.lat ?? c?.latitude ?? c?.position?.latitude);
  const lon = Number(c?.lon ?? c?.longitude ?? c?.position?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Great-circle distance in km (haversine). */
export function haversineKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * @param {object[]} cams
 * @param {{ lat: number, lon: number }} at
 * @param {{ maxKm?: number }} [opts]  ignore cameras farther than this
 * @returns {{ camera: object, index: number, distanceKm: number } | null}
 */
export function nearestCamera(cams, at, { maxKm = Infinity } = {}) {
  const here = latLonOf(at);
  if (!here || !Array.isArray(cams)) return null;
  let best = null;
  cams.forEach((camera, index) => {
    const p = latLonOf(camera);
    if (!p) return;
    const distanceKm = haversineKm(here, p);
    if (distanceKm > maxKm) return;
    if (!best || distanceKm < best.distanceKm) best = { camera, index, distanceKm };
  });
  return best;
}
