// Scene clock: the single source of "now" the Layer SDK uses to position movers.
// Live by default (now() === Date.now()); the time scrubber (Phase 17) can freeze
// it to a past instant so every mover rewinds together, reading its position from
// the same ring-buffer history that already backs trails and interpolation.
//
// Pure and testable: no Cesium, no DOM. The scrubber drives it; main subscribes a
// scene.requestRender to it so a scrub takes effect immediately.

export function createSceneClock() {
  let scrubMs = null; // null = live; otherwise a frozen absolute timestamp (ms)
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn());

  return {
    /** Current scene time in ms: the frozen instant when scrubbing, else real now. */
    now: () => (scrubMs === null ? Date.now() : scrubMs),
    isLive: () => scrubMs === null,
    scrubTime: () => scrubMs,
    /** Freeze the scene at an absolute timestamp (ms). */
    setScrub(ms) {
      const next = Number.isFinite(ms) ? ms : null;
      if (next === scrubMs) return;
      scrubMs = next;
      emit();
    },
    /** Return to live. */
    goLive() {
      if (scrubMs === null) return;
      scrubMs = null;
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
