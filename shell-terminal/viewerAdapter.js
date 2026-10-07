// A minimal stand-in for the slice of a Cesium Viewer that core's data sources
// touch: the camera's view rectangle and its moveEnd event. With it, the terminal
// shell reuses core's AIS client, Overpass client, and dev mocks unchanged
// instead of re-implementing them, keeping one data engine for every shell.

/**
 * @param {() => { west: number, south: number, east: number, north: number }} getRectRadians
 */
export function createViewerAdapter(getRectRadians) {
  const listeners = new Set();
  return {
    camera: {
      computeViewRectangle: () => getRectRadians(),
      moveEnd: {
        addEventListener(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
    },
    scene: { globe: { ellipsoid: undefined }, requestRender() {} },
    /** Called by the shell after the user pans or zooms. */
    fireMoveEnd() {
      for (const fn of listeners) fn();
    },
  };
}

/**
 * Make sure a browser-style WebSocket exists (core's push clients use the global).
 * Node 22+ ships one; on Node 20 fall back to the `ws` package.
 */
export async function ensureWebSocket() {
  if (typeof globalThis.WebSocket === 'function') return true;
  try {
    const { WebSocket } = await import('ws');
    globalThis.WebSocket = WebSocket;
    return true;
  } catch {
    return false;
  }
}
