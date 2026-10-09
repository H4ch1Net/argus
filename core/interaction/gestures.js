// Pure pointer-gesture helpers, shared by the picker and the camera input.
//
// A pointer press that barely moves and releases quickly is a tap; anything else
// is a drag (a camera orbit) and must not trigger a pick. Fingers need a larger
// movement threshold than a mouse, so the caller passes thresholds derived from
// the pointer type.

/**
 * @param {{ dx: number, dy: number, dtMs: number }} motion
 * @param {{ moveThresholdPx?: number, timeThresholdMs?: number }} [limits]
 */
export function isTap(
  { dx, dy, dtMs },
  { moveThresholdPx = 8, timeThresholdMs = 700 } = {},
) {
  return Math.hypot(dx, dy) <= moveThresholdPx && dtMs <= timeThresholdMs;
}

/** Pick tolerances by pointer type. Fingers (~8-10mm) need a bigger box than a mouse. */
export function toleranceFor(pointerType) {
  const coarse = pointerType === 'touch';
  return {
    moveThresholdPx: coarse ? 12 : 5,
    // Half-extent of the pick box, in CSS px, around the tap point.
    pickRadiusPx: coarse ? 22 : 6,
    // Taps further apart than this are not one double / triple tap.
    sequenceSlopPx: coarse ? 40 : 12,
  };
}

/** The longest gap between the taps of a double or triple tap (Android uses 300 ms). */
export const MULTI_TAP_GAP_MS = 300;

/**
 * Counts taps into single / double / triple taps. tap() returns the count of
 * the sequence this tap belongs to: 1, 2 or 3. A tap joins the sequence when
 * it comes within maxGapMs of the previous one and lands within the pointer
 * type's slop of the first; a third tap closes the sequence, so a fourth starts
 * a new one.
 * @param {{ maxGapMs?: number, slopFor?: (pointerType: string) => number }} [opts]
 */
export function createTapSequencer({
  maxGapMs = MULTI_TAP_GAP_MS,
  slopFor = (type) => toleranceFor(type).sequenceSlopPx,
} = {}) {
  let count = 0;
  let lastT = 0;
  let x0 = 0;
  let y0 = 0;
  return {
    /** @param {{ t: number, x: number, y: number, pointerType?: string }} tap */
    tap({ t, x, y, pointerType = 'mouse' }) {
      const joins =
        count > 0 &&
        t - lastT <= maxGapMs &&
        Math.hypot(x - x0, y - y0) <= slopFor(pointerType);
      if (joins) {
        count += 1;
      } else {
        count = 1;
        x0 = x;
        y0 = y;
      }
      lastT = t;
      const n = count;
      if (count >= 3) count = 0;
      return n;
    },
    reset() {
      count = 0;
    },
    get count() {
      return count;
    },
  };
}

/**
 * The zoom for one ctrl+wheel event (a trackpad pinch: Chrome, Edge and
 * Firefox send pinches as wheel events with ctrlKey, deltaY = -100 x the log
 * of the scale step). Returns the factor to divide the camera distance by:
 * above 1 zooms in. Per event it stays within half to double.
 */
export function wheelPinchFactor(deltaY, deltaMode = 0) {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 1;
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.min(2, Math.max(0.5, Math.exp(-px / 100)));
}
