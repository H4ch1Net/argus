import {
  DEFAULT_SNAPSHOT,
  shodanCountParams,
  shodanSampleParams,
  snapshotById,
} from './snapshots.js';
import { parseShodanFacetList } from './parse.js';
import { shodanFacetRows } from './format.js';

// The Shodan layer's source: one curated snapshot (snapshots.js) through the
// proxy's 'shodan' feed, which pins the query, caches answers 12 hours and
// governs the monthly credits. The density map comes from the credit-free
// /host/count; the host sample (/host/search, one page, one query credit) is
// fetched only when switched on in VIEW > SHODAN. Fetched once when the layer
// starts and again only when the snapshot or the sample switch changes: never
// on pan. Pure (no Cesium); the terminal uses it too.

/**
 * @param {{ proxyClient: object, getSnapshot?: () => string, getSample?: () => boolean }} opts
 */
export function createShodanSource({
  proxyClient,
  getSnapshot = () => DEFAULT_SNAPSHOT,
  getSample = () => false,
}) {
  return async (_query, signal) => {
    const snapshot = snapshotById(getSnapshot());
    const count = await proxyClient.getJson('shodan', '/shodan/host/count', {
      params: shodanCountParams(snapshot),
      signal,
    });
    let sample = null;
    if (getSample()) {
      try {
        sample = await proxyClient.getJson('shodan', '/shodan/host/search', {
          params: shodanSampleParams(snapshot),
          signal,
        });
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        // A spent budget (429) or no membership: the density map still stands.
        console.warn(`[argus] shodan host sample: ${err?.message || err}`);
      }
    }
    return { count, snapshot, sample };
  };
}

/**
 * One country's facets for the current snapshot (credit-free, cached at the
 * proxy): rows for the card, plus the country's total.
 */
export async function fetchCountryFacets(proxyClient, snapshotId, country, signal) {
  const snapshot = snapshotById(snapshotId);
  const json = await proxyClient.getJson('shodan', '/shodan/host/count', {
    params: shodanCountParams(snapshot, country),
    signal,
  });
  const facets = {
    ports: parseShodanFacetList(json, 'port'),
    orgs: parseShodanFacetList(json, 'org'),
    products: parseShodanFacetList(json, 'product'),
  };
  return { rows: shodanFacetRows(facets), total: json?.total ?? null, facets };
}
