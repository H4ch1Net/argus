// Response cache for slow or rate-limited upstreams (part of job 6). A feed opts
// in with `cache: { ttlMs, staleMs? }`: a 200 GET body is reused for ttlMs, so
// the globe, the terminal, and a second tab polling the same feed cost the
// upstream one request; after an upstream failure (network error, 429, 5xx) the
// last good body is served for up to staleMs instead of an error. In-memory and
// bounded by entry count and total bytes (oldest evicted first).

/**
 * @param {{ maxEntries?: number, maxBytes?: number, now?: () => number }} [opts]
 */
export function createResponseCache({
  maxEntries = 200,
  maxBytes = 48 * 1024 * 1024,
  now = () => Date.now(),
} = {}) {
  const entries = new Map(); // key -> { at, status, headers, body }
  let bytes = 0;

  const drop = (key) => {
    const e = entries.get(key);
    if (!e) return;
    bytes -= e.body.length;
    entries.delete(key);
  };

  return {
    /** The entry for key if it is at most maxAgeMs old, else null. */
    get(key, maxAgeMs) {
      const e = entries.get(key);
      if (!e || now() - e.at > maxAgeMs) return null;
      return { ...e, ageMs: now() - e.at };
    },

    /**
     * @param {string} key
     * @param {{ status: number, headers: object, body: Buffer }} entry
     * @param {{ group?: string, groupMax?: number }} [opts] a group (the feed)
     *   keeps at most groupMax entries, so a feed with many distinct URLs (map
     *   viewports) evicts its own oldest entries, not another feed's long-lived
     *   ones (satellite elements, cable routes).
     */
    set(key, { status, headers, body }, { group = null, groupMax = Infinity } = {}) {
      if (body.length > maxBytes / 4) return; // never let one body take the cache
      drop(key);
      entries.set(key, { at: now(), status, headers, body, group });
      bytes += body.length;
      if (group !== null) {
        const mine = [...entries.entries()].filter(([, e]) => e.group === group);
        for (let i = 0; i < mine.length - groupMax; i++) drop(mine[i][0]);
      }
      for (const k of entries.keys()) {
        if (entries.size <= maxEntries && bytes <= maxBytes) break;
        drop(k);
      }
    },

    get size() {
      return entries.size;
    },
  };
}
