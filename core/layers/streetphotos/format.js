import { MAPILLARY_CREDIT } from './parse.js';

// Street photo card and readouts. Pure (no Cesium), shared with the terminal.
// The card shows the photo (through the proxy), when and which way it was
// taken, and the attribution Mapillary's CC BY-SA licence asks for, with a
// link to the image on mapillary.com. It never names who took it.

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** 123 -> "123° SE". */
export function compassText(deg) {
  if (!Number.isFinite(deg)) return 'unknown';
  const d = Math.round(((deg % 360) + 360) % 360);
  return `${String(d).padStart(3, '0')}° ${POINTS[Math.round(d / 45) % 8]}`;
}

/** Epoch ms -> "2024-06-01 14:05 UTC". */
export function capturedText(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export const mapillaryImageUrl = (id) =>
  `https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}&focus=photo`;

/** The target card for a street photo. */
export function describeStreetPhoto(n, { distanceM = null } = {}) {
  const m = n.meta;
  const rows = [
    ['Captured', capturedText(m.capturedAt)],
    ['Facing', compassText(m.compass)],
    ['Kind', m.pano ? '360° panorama' : 'Photo'],
  ];
  if (Number.isFinite(distanceM))
    rows.push(['From target', `${Math.round(distanceM)} m`]);
  rows.push(['Licence', 'CC BY-SA 4.0 (Mapillary)']);
  rows.push(['Image', m.imageId]);
  return {
    id: n.id,
    title: m.demo ? 'STREET PHOTO (DEMO)' : 'STREET PHOTO',
    subtitle: m.demo
      ? 'demo point: no Mapillary token on the proxy'
      : `Mapillary, ${capturedText(m.capturedAt).slice(0, 10)}`,
    rows,
    image: m.image ? { url: m.image, alt: 'Street-level photo from Mapillary' } : null,
    links: m.demo
      ? []
      : [{ label: 'Open on Mapillary', url: mapillaryImageUrl(m.imageId) }],
    credit: MAPILLARY_CREDIT,
  };
}

export const streetPhotoSearchText = (n) => `street photo ${n.meta.imageId}`;
