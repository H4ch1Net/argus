// Double-buffered frame swaps for raster overlays (weather frames). A new frame
// is added hidden above the one on screen and loads there; only when the globe
// has finished loading its tiles (or after a timeout) is it revealed and the
// old frame removed, in the same step. So a refresh or a timeline step never
// blanks the overlay, and never shows a patchwork of tiles from two times. A
// frame superseded before it finished loading is dropped at once.
//
// Pure: the raster engine supplies how layers are added, revealed, removed and
// watched, so this logic is testable without Cesium.

/**
 * @param {{
 *   add: (next: object, below: object|null, hidden: boolean) => void,
 *   reveal: (layer: object) => void,
 *   remove: (layer: object) => void,
 *   whenLoaded: (layer: object, done: () => void) => (() => void) | void,
 *   onShown?: (layer: object) => void,
 *   timeoutMs?: number,
 *   setTimeout?: Function,
 *   clearTimeout?: Function,
 * }} hooks
 */
export function createFrameSwapper({
  add,
  reveal,
  remove,
  whenLoaded,
  onShown = () => {},
  timeoutMs = 15_000,
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
}) {
  let shown = null; // the frame on screen
  let pending = null; // the newest frame, loading hidden above it
  let stopWaiting = null;

  function dropPending() {
    stopWaiting?.();
    stopWaiting = null;
    if (pending) remove(pending);
    pending = null;
  }

  return {
    /** Put up a new frame; the current one stays until the new one has loaded. */
    show(next) {
      dropPending();
      if (!shown) {
        add(next, null, false);
        shown = next;
        onShown(next);
        return;
      }
      add(next, shown, true);
      pending = next;
      let timer = null;
      let off = null;
      const stop = () => {
        clearTimeout(timer);
        off?.();
        off = null;
      };
      const finish = () => {
        if (pending !== next) return;
        stop();
        stopWaiting = null;
        reveal(next);
        remove(shown);
        shown = next;
        pending = null;
        onShown(next);
      };
      stopWaiting = stop;
      timer = setTimeout(finish, timeoutMs);
      off = whenLoaded(next, finish) || null;
      // A frame that reported loaded at once has already been swapped in.
      if (pending !== next) stop();
    },

    /** Take every frame down (an empty frame, or the layer stopping). */
    clear() {
      dropPending();
      if (shown) remove(shown);
      shown = null;
    },

    /** The frame on screen (null when none). */
    get shown() {
      return shown;
    },
    /** The frame still loading (null when none). */
    get pending() {
      return pending;
    },
  };
}
