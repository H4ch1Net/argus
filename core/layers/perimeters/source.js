// Source for the fire perimeter layer: the WFIGS current perimeters through
// the proxy feed 'wfigs', paged while the service reports more (at most
// WFIGS_MAX_PAGES pages). Pure: no Cesium, no DOM; usable from the terminal.
// Adapted from gods-eye-view server/providers/firePerimeters.js (MIT).

import {
  WFIGS_PATH,
  WFIGS_MAX_PAGES,
  wfigsParams,
  exceededTransferLimit,
} from './parse.js';

/** All pages' features as one { features } collection. */
export async function loadPerimeters(proxyClient, { signal } = {}) {
  const features = [];
  for (let page = 0; page < WFIGS_MAX_PAGES; page++) {
    const payload = await proxyClient.getJson('wfigs', WFIGS_PATH, {
      params: wfigsParams(features.length),
      signal,
    });
    if (!Array.isArray(payload?.features))
      throw new Error('WFIGS: not a feature collection');
    features.push(...payload.features);
    if (!exceededTransferLimit(payload) || !payload.features.length) break;
  }
  return { features };
}

/** @param {{ proxyClient: object }} opts */
export function createPerimeterSource({ proxyClient }) {
  return (_query, signal) => loadPerimeters(proxyClient, { signal });
}
