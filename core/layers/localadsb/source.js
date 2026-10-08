// Source for your own receivers: 1090 MHz (local-adsb, LOCAL_ADSB_URL) and
// 978 MHz UAT (local-uat, LOCAL_UAT_URL), both localOnly proxy feeds serving
// the same aircraft.json shape. Both are fetched in parallel with allSettled, so
// one receiver being down (or not configured) never hides the other; only both
// failing is an error. parseLocalAdsb merges the result into one entity per
// aircraft. Pure: the proxy client is injected.

export const LOCAL_RECEIVER_FEEDS = Object.freeze([
  Object.freeze({ feed: 'local-adsb', band: '1090', env: 'LOCAL_ADSB_URL' }),
  Object.freeze({ feed: 'local-uat', band: '978', env: 'LOCAL_UAT_URL' }),
]);

/**
 * @param {{ proxyClient: { getJson: Function }, feeds?: { feed: string, band: string }[] }} opts
 *   feeds: the receivers to poll (default both; pass only the configured ones,
 *   e.g. filtered by the proxy's /health report, to skip a feed that is not set)
 * @returns {(query?: object, signal?: AbortSignal) => Promise<{ feeds: { band: string, payload: object }[] }>}
 */
export function createLocalReceiverSource({ proxyClient, feeds = LOCAL_RECEIVER_FEEDS }) {
  return async (_query, signal) => {
    const settled = await Promise.allSettled(
      feeds.map(async ({ feed, band }) => ({
        band,
        payload: await proxyClient.getJson(feed, '/aircraft.json', { signal }),
      })),
    );
    const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (!ok.length && settled.length) throw settled[0].reason;
    return { feeds: ok };
  };
}
