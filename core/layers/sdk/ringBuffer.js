// Bounded ring buffer of recent fixes, per entity.
//
// The plan logs every fix to a bounded in-memory ring buffer from the first
// mover layer: interpolation needs the last two fixes now, and the time-scrubber
// (later phase) will read the recent history. Nothing is persisted to disk; the
// buffer evaporates on close, keeping "live only" honest.

/**
 * @param {number} capacity max fixes retained (oldest dropped past this)
 */
export function createRingBuffer(capacity) {
  if (!(capacity > 0)) throw new Error('ring buffer capacity must be > 0');
  const items = [];
  let cap = capacity;
  return {
    push(x) {
      items.push(x);
      if (items.length > cap) items.shift();
      return this;
    },
    /**
     * Backfill: put fixes older than the oldest retained one in front (a
     * selected aircraft's earlier track fetched on demand). The buffer grows to
     * hold them, up to `limit`, so the next live fix does not push them out.
     */
    prepend(fixes, limit = capacity) {
      const oldest = items.length ? items[0].t : Infinity;
      const older = fixes.filter((f) => Number.isFinite(f?.t) && f.t < oldest);
      if (!older.length) return 0;
      older.sort((a, b) => a.t - b.t);
      items.unshift(...older);
      cap = Math.max(cap, Math.min(limit, items.length));
      while (items.length > cap) items.shift();
      return older.length;
    },
    get size() {
      return items.length;
    },
    first() {
      return items[0];
    },
    last() {
      return items[items.length - 1];
    },
    prev() {
      return items[items.length - 2];
    },
    toArray() {
      return items.slice();
    },
    // Position at an arbitrary time (the time scrubber): the fix bracketing tMs,
    // interpolated via `interp(prev, curr, tMs)`; clamped to the ends of the
    // retained window. Allocation-free so it is cheap to call per frame.
    sampleAt(tMs, interp) {
      const n = items.length;
      if (!n) return undefined;
      if (tMs <= items[0].t) return items[0];
      if (tMs >= items[n - 1].t) return items[n - 1];
      for (let i = n - 1; i > 0; i -= 1) {
        if (items[i - 1].t <= tMs && tMs <= items[i].t) {
          return interp(items[i - 1], items[i], tMs);
        }
      }
      return items[n - 1];
    },
    /** sampleAt without allocating: interpInto(prev, curr, tMs, out). */
    sampleInto(tMs, interpInto, out) {
      const n = items.length;
      if (!n) return undefined;
      const copy = (f) => {
        out.longitude = f.longitude;
        out.latitude = f.latitude;
        out.altitude = f.altitude ?? 0;
        return out;
      };
      if (tMs <= items[0].t) return copy(items[0]);
      if (tMs >= items[n - 1].t) return copy(items[n - 1]);
      for (let i = n - 1; i > 0; i -= 1) {
        if (items[i - 1].t <= tMs && tMs <= items[i].t) {
          return interpInto(items[i - 1], items[i], tMs, out);
        }
      }
      return copy(items[n - 1]);
    },
    clear() {
      items.length = 0;
    },
  };
}
