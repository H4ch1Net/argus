// A small client-side queue for per-aircraft lookups (adsbdb enrichment): at
// most 4 requests in flight, dispatches dripped (~5/s), nearest aircraft first,
// each key asked once (answers, misses included, are kept 24 h). Lookups never
// surface errors: a failed one resolves null and is not cached, so it can be
// asked again later. Adapted from gods-eye-view src/layers/flights/enrichment.js
// (MIT). Pure: the fetch function and the clock are injected.

const DAY = 24 * 60 * 60 * 1000;

/**
 * @param {Object} o
 * @param {(key: string, signal: AbortSignal) => Promise<any>} o.fetch  key -> value (null = known miss)
 * @param {number} [o.concurrency=4]
 * @param {number} [o.minGapMs=200]   at least this long between dispatches
 * @param {number} [o.ttlMs]          how long an answer (or a miss) is kept (24 h)
 * @param {number} [o.maxEntries=5000] answers kept (oldest dropped first)
 * @param {(key: string) => number} [o.distanceOf] read at dispatch time, so the
 *   queue follows the camera; else each request's own `distance` is used
 * @param {() => number} [o.now]
 * @param {(fn: Function, ms: number) => any} [o.setTimer]
 * @param {(id: any) => void} [o.clearTimer]
 */
export function createEnrichQueue({
  fetch: fetchFn,
  concurrency = 4,
  minGapMs = 200,
  ttlMs = DAY,
  maxEntries = 5000,
  distanceOf = null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  const cache = new Map(); // key -> { at, value }
  const jobs = new Map(); // key -> { key, distance, priority, promise, resolve, controller? }
  const queued = new Set(); // keys waiting to dispatch
  let active = 0;
  let lastDispatch = -Infinity;
  let timer = null;

  const fresh = (key) => {
    const e = cache.get(key);
    if (!e) return null;
    if (now() - e.at >= ttlMs) {
      cache.delete(key);
      return null;
    }
    return e;
  };

  const remember = (key, value) => {
    cache.delete(key);
    cache.set(key, { at: now(), value });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  };

  const rank = (job) =>
    job.priority
      ? -Infinity
      : distanceOf
        ? (distanceOf(job.key) ?? Infinity)
        : job.distance;

  function nextJob() {
    let best = null;
    let bestRank = Infinity;
    for (const key of queued) {
      const job = jobs.get(key);
      const r = rank(job);
      if (best === null || r < bestRank) {
        best = job;
        bestRank = r;
      }
    }
    return best;
  }

  function drain() {
    while (active < concurrency && queued.size) {
      const wait = minGapMs - (now() - lastDispatch);
      if (wait > 0) {
        if (timer === null) {
          timer = setTimer(() => {
            timer = null;
            drain();
          }, wait);
        }
        return;
      }
      const job = nextJob();
      queued.delete(job.key);
      lastDispatch = now();
      active += 1;
      job.controller = new AbortController();
      Promise.resolve()
        .then(() => fetchFn(job.key, job.controller.signal))
        .then(
          (value) => {
            if (!job.controller.signal.aborted) remember(job.key, value ?? null);
            job.resolve(value ?? null);
          },
          () => job.resolve(null), // fail-silent; not cached, so it can be retried
        )
        .finally(() => {
          jobs.delete(job.key);
          active -= 1;
          drain();
        });
    }
  }

  return {
    /**
     * Ask for a key. Resolves with the value, or null (a miss, or a failure).
     * @param {string} key
     * @param {{ distance?: number, priority?: boolean }} [o] priority: the
     *   selected aircraft jumps the queue; distance: nearer goes first
     */
    request(key, { distance = Infinity, priority = false } = {}) {
      const hit = fresh(key);
      if (hit) return Promise.resolve(hit.value);
      const pending = jobs.get(key);
      if (pending) {
        pending.distance = Math.min(pending.distance, distance);
        pending.priority ||= priority;
        return pending.promise;
      }
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      jobs.set(key, { key, distance, priority, promise, resolve, controller: null });
      queued.add(key);
      drain();
      return promise;
    },

    /** The cached answer for a key, synchronously: { value } or undefined. */
    peek(key) {
      const hit = fresh(key);
      return hit ? { value: hit.value } : undefined;
    },

    /** Drop everything waiting (resolving it null) and abort what is in flight. */
    clear() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      for (const key of queued) jobs.get(key).resolve(null);
      for (const key of queued) jobs.delete(key);
      queued.clear();
      for (const job of jobs.values()) job.controller?.abort();
    },

    get stats() {
      return { queued: queued.size, active, cached: cache.size };
    },
  };
}
