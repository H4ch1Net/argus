// Pure pointer-gesture helpers, shared by the picker.
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
  };
}
