// The transit layer's source, shared by every shell: fetch the GTFS-RT feeds of
// the agencies in view through the proxy (as bytes) and decode them. One failing
// agency does not blank the others; only when every one fails is it an error.

import { TRANSIT_AGENCIES, agenciesInView } from './agencies.js';
import { decodeVehiclePositions } from './gtfsrt.js';

/**
 * @param {{ proxyClient: { getBytes: Function }, agencies?: object[] }} opts
 * @returns {(query: { bbox?: object }, signal?: AbortSignal) => Promise<object>}
 */
export function createTransitSource({ proxyClient, agencies = TRANSIT_AGENCIES }) {
  return async (query, signal) => {
    const view = agenciesInView(query?.bbox, agencies);
    const results = await Promise.allSettled(
      view.agencies.map(async (agency) => ({
        agency,
        ...decodeVehiclePositions(
          await proxyClient.getBytes(agency.feedId, agency.path, { signal }),
        ),
      })),
    );
    const feeds = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length && !feeds.length) throw failed[0].reason;
    return {
      feeds,
      failed: failed.map((r, i) => ({
        agency: view.agencies[results.indexOf(r)]?.name ?? String(i),
        message: String(r.reason?.message || r.reason),
      })),
      tooWide: view.tooWide,
      inView: view.agencies.length,
    };
  };
}
