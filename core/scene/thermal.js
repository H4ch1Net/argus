import { createThermalLadder } from '../capability/thermalLadder.js';

// Bind the thermal budget ladder (core/capability/thermalLadder.js) to a scene:
// time consecutive rendered frames, and when the ladder steps, run that rung's
// action. Rungs are cumulative and reversible: stepping down to rung n applies
// rung n; recovering from it undoes rung n. The actions come from the caller
// (main.js), which owns the shaders, resolution, and terrain controllers and
// only passes rungs that actually change something on this device.

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{
 *   rungs: Array<{ label: string, down: () => void, up: () => void }>,
 *   onChange?: (level: number, label: string, direction: 'down'|'up') => void,
 * }} opts
 */
export function attachThermalLadder(viewer, { rungs, onChange }) {
  const ladder = createThermalLadder({
    // Read live: cockpit mode raises the cap to 60 fps, which tightens the budget.
    getTargetFrameRate: () => viewer.targetFrameRate,
    labels: ['full quality', ...rungs.map((r) => r.label)],
  });
  let last = null;
  const remove = viewer.scene.postRender.addEventListener(() => {
    const t = performance.now();
    if (last !== null) {
      const r = ladder.sample(t - last);
      if (r.changed) {
        try {
          if (r.direction === 'down') rungs[r.level - 1].down();
          else rungs[r.level].up();
        } catch (err) {
          console.warn('[argus] thermal step failed', err);
        }
        onChange?.(r.level, ladder.label, r.direction);
      }
    }
    last = t;
  });
  return { ladder, detach: () => remove() };
}
