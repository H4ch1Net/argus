// Shodan country facets on the target card: when a country's density square
// is selected, the same snapshot narrowed to that country (credit-free
// /host/count with port, operator and product facets, cached 12 hours at the
// proxy) fills in its top ports, operators and products. One request per
// country and snapshot per session, on a tap, never on pan. Pure (no DOM).

/**
 * @param {{ fetchFacets: (snapshotId: string, country: string) =>
 *   Promise<{ rows: [string, string][] }>, getSnapshot: () => string }} deps
 */
export function createShodanExtras({ fetchFacets, getSnapshot }) {
  const cache = new Map(); // `${snapshot}:${country}` -> 'busy' | { rows } | { error }
  const keyOf = (n) => `${getSnapshot()}:${n.meta.country}`;
  const isCountry = (key, n) => key === 'shodan' && n?.type === 'shodan-density';
  return {
    rows(key, n) {
      if (!isCountry(key, n)) return [];
      const v = cache.get(keyOf(n));
      if (!v) return [];
      if (v === 'busy') return [['Facets', 'loading']];
      return v.rows ?? [['Facets', 'unavailable']];
    },
    async onSelect(key, n, ctx) {
      if (!isCountry(key, n) || !fetchFacets) return;
      const k = keyOf(n);
      if (cache.has(k) && cache.get(k).rows) return;
      cache.set(k, 'busy');
      ctx.refresh();
      try {
        const { rows } = await fetchFacets(getSnapshot(), n.meta.country);
        cache.set(k, { rows });
      } catch (err) {
        cache.set(k, { error: String(err?.message || err) });
        console.warn(`[argus] shodan facets ${k}: ${err?.message || err}`);
      }
      ctx.refresh();
    },
  };
}
