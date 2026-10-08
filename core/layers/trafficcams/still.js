// A traffic camera's latest published still, fetched once through the proxy
// and held as a Blob, so the card and the 3D projection show the same frame
// from one request. Handles both still formats the catalogues produce: a plain
// image (Caltrans, TfL, Vegvesen, ...) and TxDOT's JSON wrapping a base64 JPEG
// ('json-base64-jpeg', decoded by ./format.js). Cesium-free and DOM-free:
// fetch, Blob and URL.createObjectURL exist in browsers and in Node.
//
// GUARDRAIL: the still is fetched to be shown as published. Nothing reads,
// measures or analyses its pixels.

import { jpegFromSnapshotJson, MAX_STILL_BYTES } from './format.js';

/**
 * @param {{ url: string, format?: string|null, field?: string }} image  the
 *   card model's image (describeTrafficCam(n).image): a proxy URL, and for
 *   TxDOT format 'json-base64-jpeg' with the JSON field holding the JPEG
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ blob: Blob, url: string, revoke: () => void }>}
 *   url is a blob: URL for an <img> or the projection; revoke() frees it
 */
export async function loadStill(image, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (!image?.url) throw new Error('no still for this camera');
  const json = image.format === 'json-base64-jpeg';
  if (image.format && !json) throw new Error(`unknown still format ${image.format}`);
  const res = await fetchImpl(image.url, {
    signal,
    headers: { accept: json ? 'application/json' : 'image/*' },
  });
  if (!res.ok) throw new Error(`still unavailable (HTTP ${res.status})`);
  let blob;
  if (json) {
    const bytes = jpegFromSnapshotJson(await res.json(), image.field || 'snippet');
    if (!bytes) throw new Error('the snapshot holds no JPEG');
    blob = new Blob([bytes], { type: 'image/jpeg' });
  } else {
    blob = await res.blob();
    if (!/^image\//i.test(blob.type)) throw new Error('the still is not an image');
    if (blob.size > MAX_STILL_BYTES) throw new Error('the still is too large');
  }
  const url = URL.createObjectURL(blob);
  let live = true;
  return {
    blob,
    url,
    revoke() {
      if (!live) return;
      live = false;
      URL.revokeObjectURL(url);
    },
  };
}
