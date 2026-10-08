// Frame pacing, shared. The scene renders on demand (requestRenderMode) and never
// switches to continuous rendering. Anything that animates (a moving layer, a
// sensor shader, cockpit mode) holds a claim with the frame rate it needs, and a
// single ticker requests frames at the highest claimed rate. Aircraft tweened
// between 15 s fixes look smooth at 30 fps on a desktop and 20 on a phone, so
// the GPU does a third to half of the work continuous 60 fps rendering would,
// and an idle scene with nothing moving costs nothing at all. Camera moves still
// render at full rate: Cesium requests those frames itself.
// No Cesium import: it only calls scene.requestRender().

const pacers = new WeakMap(); // scene -> { claims: Map<fps, count>, timer, fps }

function retick(scene, st) {
  let fps = 0;
  for (const [rate, count] of st.claims) if (count > 0 && rate > fps) fps = rate;
  if (fps === st.fps) return;
  if (st.timer) clearInterval(st.timer);
  st.timer = null;
  st.fps = fps;
  if (fps > 0) {
    st.timer = setInterval(() => scene.requestRender(), Math.round(1000 / fps));
    scene.requestRender();
  }
}

/** Start (or keep) animating on behalf of one owner, at `fps` frames per second. */
export function acquireContinuousRender(scene, fps = 30) {
  const st = pacers.get(scene) ?? { claims: new Map(), timer: null, fps: 0 };
  pacers.set(scene, st);
  st.claims.set(fps, (st.claims.get(fps) ?? 0) + 1);
  retick(scene, st);
}

/** Release one owner's claim made at `fps`; the last release stops the ticker. */
export function releaseContinuousRender(scene, fps = 30) {
  const st = pacers.get(scene);
  const count = st?.claims.get(fps) ?? 0;
  if (!count) return;
  if (count === 1) st.claims.delete(fps);
  else st.claims.set(fps, count - 1);
  retick(scene, st);
  if (!st.fps) scene.requestRender?.();
}

/** The frame rate animation currently runs at (0 when nothing animates). */
export function animationFps(scene) {
  return pacers.get(scene)?.fps ?? 0;
}
