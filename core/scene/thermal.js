import { createThermalLadder } from '../capability/thermalLadder.js';

// Bind the thermal budget ladder (core/capability/thermalLadder.js) to a scene:
// time consecutive rendered frames, and when the ladder steps, run that rung's
// action. Rungs are cumulative and reversible: stepping down to rung n applies
// rung n; recovering from it undoes rung n. The actions come from the caller
// (main.js), which owns the shaders, resolution, and terrain controllers.

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{
 *   targetFrameRate: number,
 *   rungs: Array<{ down: () => void, up: () => void }>,   // index 1..3
 *   onChange?: (level: number, label: string, direction: 'down'|'up') => void,
 * }} opts
 */
export function attachThermalLadder(viewer, { targetFrameRate, rungs, onChange }) {
  const ladder = createThermalLadder({ targetFrameRate, maxLevel: rungs.length - 1 });
  let last = null;
  const remove = viewer.scene.postRender.addEventListener(() => {
    const t = performance.now();
    if (last !== null) {
      const r = ladder.sample(t - last);
      if (r.changed) {
        try {
          if (r.direction === 'down') rungs[r.level]?.down();
          else rungs[r.level + 1]?.up();
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
