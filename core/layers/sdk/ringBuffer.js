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
  return {
    push(x) {
      items.push(x);
      if (items.length > capacity) items.shift();
      return this;
    },
    get size() {
      return items.length;
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
    clear() {
      items.length = 0;
    },
  };
}
