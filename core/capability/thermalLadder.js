// Thermal budget ladder (CLAUDE.md mobile constraints, master plan 6.2). Pure.
//
// Android exposes no thermal API to the web, so throttling is inferred from a
// rising frame-time trend: when sustained frame times climb well past the frame
// budget compared with how the same session started, quality steps down one rung:
//
//   0 full quality -> 1 drop post-processing -> 2 drop resolutionScale
//                  -> 3 drop to free (flat) terrain
//
// (The caller may pass fewer rungs, e.g. none for post-processing on a device
// that has no shaders, so no step is wasted on a rung that changes nothing.)
//
// Frame times are judged as a fraction of the CURRENT frame budget, so cockpit
// mode raising the cap to 60 fps tightens the budget instead of hiding load.
// Only continuous rendering counts: with requestRenderMode an idle scene renders
// sporadically, and an idle gap resets the evidence rather than adding to it.
// Each step is followed by a cooldown so its effect is measured before the next.
//
// Recovery cannot see headroom (frame intervals are capped by the frame-rate
// cap, so "comfortable" looks the same however cool the device is). So it backs
// off: every time a recovery is followed by another step down, the next recovery
// waits twice as long. A device that keeps reheating settles at the rung that
// holds instead of cycling (which, at the terrain rung, would also reload
// photoreal tiles over and over).

export const THERMAL_LEVELS = [
  'full quality',
  'post-processing off',
  'reduced resolution',
  'flat terrain',
];

/**
 * @param {object} opts
 * @param {number} [opts.targetFrameRate]       fixed frame-rate cap (budget = 1000 / this)
 * @param {() => number} [opts.getTargetFrameRate] live frame-rate cap (wins over targetFrameRate)
 * @param {string[]} [opts.labels]              one label per level, level 0 first
 * @param {() => number} [opts.now]
 * @param {number} [opts.overloadFactor=1.35]  sustained frame time above budget * this is overload
 * @param {number} [opts.trendFactor=1.25]     ...and above the session baseline * this (a rising trend)
 * @param {number} [opts.sustainMs=8000]       overload must last this long before a step
 * @param {number} [opts.cooldownMs=20000]     settle time after a step before judging again
 * @param {number} [opts.recoverMs=120000]     comfortable time before the first step back up
 * @param {number} [opts.maxRecoverMs=1800000] cap for the backed-off recovery wait
 * @param {number} [opts.idleGapMs=250]        frame gaps longer than this are idle, not load
 */
export function createThermalLadder({
  targetFrameRate = 30,
  getTargetFrameRate = null,
  labels = THERMAL_LEVELS,
  now = () => Date.now(),
  overloadFactor = 1.35,
  trendFactor = 1.25,
  sustainMs = 8000,
  cooldownMs = 20000,
  recoverMs = 120_000,
  maxRecoverMs = 30 * 60_000,
  idleGapMs = 250,
} = {}) {
  const maxLevel = labels.length - 1;
  const budgetMs = () => 1000 / (getTargetFrameRate?.() || targetFrameRate || 30);
  let level = 0;
  let ema = null; // smoothed load: frame time / current budget
  let baseline = null; // early-session load (the "cool" reference)
  let baselineSamples = 0;
  let overloadSince = null;
  let comfortableSince = null;
  let lastStepAt = -Infinity;
  let recoverWait = recoverMs;
  let lastDirection = null;

  const resetEvidence = () => {
    overloadSince = null;
    comfortableSince = null;
    ema = null;
  };

  return {
    get level() {
      return level;
    },
    get label() {
      return labels[level];
    },
    /** Smoothed frame time as a fraction of the budget (1 = exactly on budget). */
    get load() {
      return ema;
    },
    get recoverWait() {
      return recoverWait;
    },

    /**
     * Feed the time between two consecutive rendered frames. Returns
     * { level, changed, direction } so the caller can apply a step.
     */
    sample(dtMs) {
      const t = now();
      if (!(dtMs > 0) || dtMs > idleGapMs) {
        // Idle gap (on-demand rendering, backgrounded tab): not evidence of
        // load or of recovery, and whatever was building up before it is stale.
        resetEvidence();
        return { level, changed: false };
      }
      const ratio = dtMs / budgetMs();
      ema = ema === null ? ratio : ema * 0.9 + ratio * 0.1;
      if (baselineSamples < 120) {
        baseline =
          baseline === null
            ? ratio
            : (baseline * baselineSamples + ratio) / (baselineSamples + 1);
        baselineSamples += 1;
        return { level, changed: false };
      }

      const overloaded = ema > overloadFactor && ema > baseline * trendFactor;
      const comfortable = ema < 1.1;
      overloadSince = overloaded ? (overloadSince ?? t) : null;
      comfortableSince = comfortable ? (comfortableSince ?? t) : null;
      if (t - lastStepAt < cooldownMs) return { level, changed: false };

      if (overloadSince !== null && t - overloadSince >= sustainMs && level < maxLevel) {
        // A step down right after a recovery means the recovery was premature.
        if (lastDirection === 'up') recoverWait = Math.min(maxRecoverMs, recoverWait * 2);
        level += 1;
        lastStepAt = t;
        lastDirection = 'down';
        resetEvidence(); // re-measure at the new quality
        return { level, changed: true, direction: 'down' };
      }
      if (comfortableSince !== null && t - comfortableSince >= recoverWait && level > 0) {
        level -= 1;
        lastStepAt = t;
        lastDirection = 'up';
        comfortableSince = null;
        return { level, changed: true, direction: 'up' };
      }
      return { level, changed: false };
    },

    /** Force a level (e.g. a user override); resets the timers. */
    setLevel(l) {
      level = Math.max(0, Math.min(maxLevel, l));
      resetEvidence();
      lastStepAt = now();
    },
  };
}
