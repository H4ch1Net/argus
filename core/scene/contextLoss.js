// WebGL context-loss handling, wired from day one.
//
// Master plan 6.3 (verified): context loss is routine on Android (backgrounding,
// memory pressure, OS GPU reclaim) and is the single biggest thing that makes
// Cesium apps feel broken on mobile. A full page reload is not acceptable
// recovery. Cesium restores much of its own GL state on `webglcontextrestored`,
// so our job here is: prevent the default (which would make the loss permanent),
// keep the app informed, and force a redraw on restore.

/**
 * Attach context-loss listeners to a viewer's canvas.
 *
 * @param {import('cesium').Viewer} viewer
 * @param {(state: { lost: boolean }) => void} [onChange] - notified on loss/restore
 * @returns {() => void} detach function
 */
export function wireContextLossHandling(viewer, onChange) {
  const canvas = viewer.scene.canvas;

  const handleLost = (event) => {
    // Prevent default so the browser will attempt to restore the context
    // instead of leaving it permanently lost.
    event.preventDefault();
    onChange?.({ lost: true });
  };

  const handleRestored = () => {
    // Nudge Cesium to rebuild and repaint. With requestRenderMode on, an
    // explicit requestRender is what actually brings the globe back.
    try {
      viewer.scene.requestRender();
    } catch {
      // Scene may still be settling; the next frame will pick it up.
    }
    onChange?.({ lost: false });
  };

  canvas.addEventListener('webglcontextlost', handleLost, false);
  canvas.addEventListener('webglcontextrestored', handleRestored, false);

  return () => {
    canvas.removeEventListener('webglcontextlost', handleLost, false);
    canvas.removeEventListener('webglcontextrestored', handleRestored, false);
  };
}
