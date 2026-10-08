// The terminator source: nothing to fetch for the shade (it is computed), so
// it stamps the time; with a proxy it also asks, once per session, for the
// NASA Black Marble night-lights image through the pinned 'gibs-night' feed
// (the proxy caches it for days). Returns { at, lights: Promise<Uint8Array> | null }.

import { blackMarbleQuery, BLACK_MARBLE_PATH } from './night.js';

/**
 * @param {{ proxyClient?: object | null, lights?: boolean, width?: number }} [opts]
 *   width: the overlay width (1024 or 2048; terminatorWidth(fps) in definition.js)
 */
export function createTerminatorSource({ proxyClient = null, lights = true, width = 1024 } = {}) {
  let pending = null;
  return async () => {
    if (lights && proxyClient && !pending) {
      pending = proxyClient
        .getBytes('gibs-night', BLACK_MARBLE_PATH, { params: blackMarbleQuery(width) })
        .catch(() => {
          pending = null; // try again on the next refresh
          return null;
        });
    }
    return { at: Date.now(), lights: pending };
  };
}
