// Continuous rendering, shared. The scene renders on demand (requestRenderMode)
// unless something animates: a moving layer (flights, ships, satellites), or a
// sensor shader. Each of those holds a claim; the scene's own mode is saved by
// the first claim and restored only when the last is released, so one owner
// turning off never freezes another, and nothing is left rendering at idle.
// No Cesium import: it only flips the scene's flag.

const claims = new WeakMap(); // scene -> { count, saved }

/** Start (or keep) continuous rendering on behalf of one owner. */
export function acquireContinuousRender(scene) {
  const st = claims.get(scene) ?? { count: 0, saved: scene.requestRenderMode };
  if (st.count === 0) st.saved = scene.requestRenderMode;
  st.count += 1;
  claims.set(scene, st);
  scene.requestRenderMode = false;
}

/** Release one owner's claim; the last release restores on-demand rendering. */
export function releaseContinuousRender(scene) {
  const st = claims.get(scene);
  if (!st || st.count === 0) return;
  st.count -= 1;
  if (st.count === 0) {
    scene.requestRenderMode = st.saved;
    scene.requestRender?.();
  }
}
