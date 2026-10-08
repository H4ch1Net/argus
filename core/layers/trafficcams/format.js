// Traffic camera entities + card. Pure.

import { compassPoint } from './pose.js';

/** Source result -> normalized entities (type 'trafficcam'). */
export function parseTrafficCams(result) {
  return (result?.cameras ?? []).map((c) => ({
    id: `cam:${c.id}`,
    type: 'trafficcam',
    position: { longitude: c.lon, latitude: c.lat, altitude: 0 },
    meta: {
      name: c.name,
      provider: c.provider,
      region: c.region,
      license: c.license,
      licenseUrl: c.licenseUrl ?? null,
      credit: c.credit ?? null,
      curated: Boolean(c.curated),
      direction: c.direction ?? null,
      pose: c.pose ?? null,
      imageUrl: c.imageUrl ?? null,
      imageFormat: c.imageFormat ?? null,
      demo: Boolean(c.demo),
    },
  }));
}

export function trafficCamNote(result) {
  if (!result) return '';
  if (result.tooWide) return 'zoom to a covered region';
  if (!result.inView) return 'no camera network in view';
  return result.failed ? `${result.failed} catalogue(s) failed` : '';
}

/**
 * What the card says about where the camera looks: the feed's own direction
 * text, else a heading the feed (or a curated catalogue) states. The hashed
 * stand-in heading used for unknown cameras is never shown as a facing.
 */
function facing(m) {
  if (m.direction) return m.direction;
  const p = m.pose;
  if (!p || p.headingSource === 'hash') return '—';
  const label = `${compassPoint(p.heading)} (${Math.round(p.heading)}°)`;
  if (p.headingSource === 'curated')
    return p.headingConfidence === 'high'
      ? `${label}, curated`
      : `about ${label}, curated`;
  return label;
}

function sourceLine(m) {
  if (m.demo) return 'demo (simulated)';
  return m.curated
    ? `${m.provider} (curated catalogue, stills via the proxy)`
    : `${m.provider} (public catalogue, stills via the proxy)`;
}

export function describeTrafficCam(n) {
  const m = n.meta;
  // A still that is a plain image is loaded straight from its proxy URL. A
  // TxDOT still arrives as JSON wrapping a base64 JPEG (format
  // 'json-base64-jpeg'): the card fetches it, decodes it with
  // jpegFromSnapshotJson() and shows it through a Blob URL.
  const image = m.imageUrl
    ? {
        url: m.imageUrl,
        alt: `Latest still: ${m.name}`,
        ...(m.imageFormat ? { format: m.imageFormat, field: 'snippet' } : {}),
      }
    : null;
  const links = [];
  if (m.imageUrl && !m.imageFormat)
    links.push({ label: 'Open the latest still', url: m.imageUrl });
  if (m.licenseUrl) links.push({ label: 'Licence and terms', url: m.licenseUrl });
  return {
    id: n.id,
    title: m.name,
    subtitle: `${m.provider} · ${m.region}`,
    rows: [
      ['Facing', facing(m)],
      [
        'Coordinates',
        `${n.position.latitude.toFixed(4)}, ${n.position.longitude.toFixed(4)}`,
      ],
      ['Source', sourceLine(m)],
      ...(m.demo ? [] : [['Licence', m.license]]),
      ...(m.credit ? [['Image credit', m.credit]] : []),
      ['Note', 'Published still only; nothing here analyses it'],
    ],
    // The still loads only when this card opens, through the proxy.
    image,
    // The credit line the licence asks for, for a card that shows one.
    credit: m.demo ? null : m.license,
    links,
  };
}

export const trafficCamSearchText = (n) =>
  `${n.meta.name} ${n.meta.provider} ${n.meta.region} camera`;

/** Largest decoded still accepted (TxDOT frames are tens of kilobytes). */
export const MAX_STILL_BYTES = 8 * 1024 * 1024;

// Canonical base64 only (4-character groups, padding only at the end): a
// lenient decoder would turn a non-image body into "something".
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * A base64 JPEG -> its bytes, or null unless it is canonical base64 that
 * decodes to at most maxBytes starting with the JPEG magic FF D8 FF. A
 * `data:image/jpeg;base64,` prefix is allowed. Adapted from gods-eye-view
 * server/providers/cctv/media.js fetchTxdotSnapshot (MIT).
 * @returns {Uint8Array|null}
 */
export function decodeBase64Jpeg(b64, maxBytes = MAX_STILL_BYTES) {
  if (typeof b64 !== 'string') return null;
  const s = b64.trim().replace(/^data:image\/jpeg;base64,/i, '');
  if (s.length < 8 || s.length > Math.ceil((maxBytes * 4) / 3) + 4 || !BASE64.test(s))
    return null;
  let bin;
  try {
    bin = atob(s);
  } catch {
    return null;
  }
  if (bin.length > maxBytes) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
}

/** A TxDOT snapshot response ({ snippet: <base64 JPEG> }) -> JPEG bytes, or null. */
export const jpegFromSnapshotJson = (json, field = 'snippet') =>
  decodeBase64Jpeg(json && typeof json === 'object' ? json[field] : null);
