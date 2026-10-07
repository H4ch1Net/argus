// Thermal budget ladder (CLAUDE.md mobile constraints, master plan 6.2). Pure.
//
// Android exposes no thermal API to the web, so throttling is inferred from a
// rising frame-time trend: when sustained frame times climb well past the frame
// budget compared with how the same session started, quality steps down one rung:
//
//   0 full quality -> 1 drop post-processing -> 2 drop resolutionScale
//                  -> 3 drop to free (flat) terrain
//
// Only continuous rendering counts: with requestRenderMode an idle scene renders
// sporadically, and those long gaps are not load. Each step is followed by a
// cooldown so the effect of the last step is measured before the next. Recovery
// is deliberately slow (a long stretch comfortably under budget) so a device
// that is cooling down does not oscillate.

export const THERMAL_LEVELS = [
  'full quality',
  'post-processing off',
  'reduced resolution',
  'flat terrain',
];

/**
 * @param {object} opts
 * @param {number} opts.targetFrameRate   the scene's frame-rate cap (frame budget = 1000 / this)
 * @param {() => number} [opts.now]
 * @param {number} [opts.maxLevel=3]
 * @param {number} [opts.overloadFactor=1.35]  sustained frame time above budget * this is overload
 * @param {number} [opts.trendFactor=1.25]     ...and above the session baseline * this (a rising trend)
 * @param {number} [opts.sustainMs=8000]       overload must last this long before a step
 * @param {number} [opts.cooldownMs=20000]     settle time after a step before judging again
 * @param {number} [opts.recoverMs=120000]     comfortable time before stepping back up
 * @param {number} [opts.idleGapMs=250]        frame gaps longer than this are idle, not load
 */
export function createThermalLadder({
  targetFrameRate,
  now = () => Date.now(),
  maxLevel = 3,
  overloadFactor = 1.35,
  trendFactor = 1.25,
  sustainMs = 8000,
  cooldownMs = 20000,
  recoverMs = 120_000,
  idleGapMs = 250,
} = {}) {
  const budget = 1000 / (targetFrameRate || 30);
  let level = 0;
  let ema = null; // smoothed frame time
  let baseline = null; // early-session frame time (the "cool" reference)
  let baselineSamples = 0;
  let overloadSince = null;
  let comfortableSince = null;
  let lastStepAt = -Infinity;

  return {
    get level() {
      return level;
    },
    get label() {
      return THERMAL_LEVELS[level];
    },
    get frameTime() {
      return ema;
    },

    /**
     * Feed the time between two consecutive rendered frames. Returns
     * { level, changed, direction } so the caller can apply a step.
     */
    sample(dtMs) {
      const t = now();
      if (!(dtMs > 0) || dtMs > idleGapMs) {
        // Idle gap: not evidence of load or of recovery.
        return { level, changed: false };
      }
      ema = ema === null ? dtMs : ema * 0.9 + dtMs * 0.1;
      if (baselineSamples < 120) {
        baseline =
          baseline === null
            ? dtMs
            : (baseline * baselineSamples + dtMs) / (baselineSamples + 1);
        baselineSamples += 1;
        return { level, changed: false };
      }

      const overloaded = ema > budget * overloadFactor && ema > baseline * trendFactor;
      const comfortable = ema < budget * 1.1;
      overloadSince = overloaded ? (overloadSince ?? t) : null;
      comfortableSince = comfortable ? (comfortableSince ?? t) : null;
      if (t - lastStepAt < cooldownMs) return { level, changed: false };

      if (overloadSince !== null && t - overloadSince >= sustainMs && level < maxLevel) {
        level += 1;
        lastStepAt = t;
        overloadSince = null;
        ema = null; // re-measure at the new quality
        return { level, changed: true, direction: 'down' };
      }
      if (comfortableSince !== null && t - comfortableSince >= recoverMs && level > 0) {
        level -= 1;
        lastStepAt = t;
        comfortableSince = null;
        return { level, changed: true, direction: 'up' };
      }
      return { level, changed: false };
    },

    /** Force a level (e.g. a user override); resets the timers. */
    setLevel(l) {
      level = Math.max(0, Math.min(maxLevel, l));
      overloadSince = comfortableSince = null;
      lastStepAt = now();
    },
  };
}
