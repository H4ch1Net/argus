import { computeViewportQuery } from '../sdk/viewport.js';

// AIS push source: a websocket client to the proxy's /ws/ais endpoint. It sends
// the current viewport bbox (on connect and after camera moves) and forwards
// each batch of ships to the layer. Reconnects with exponential backoff.
//
// Returns the SDK push-source signature: (onBatch) => unsubscribe.

/**
 * @param {{ wsUrl: string, viewer: import('cesium').Viewer }} opts
 */
export function createAisSource({ wsUrl, viewer }) {
  return (onBatch) => {
    let ws = null;
    let closed = false;
    let delay = 1000;
    let sendTimer = null;

    const sendBBox = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: 'bbox', bbox: computeViewportQuery(viewer).bbox }),
        );
      }
    };

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        delay = 1000;
        sendBBox();
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'ships' && m.ships?.length) onBatch(m.ships);
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (!closed) {
          setTimeout(connect, delay);
          delay = Math.min(delay * 2, 30_000);
        }
      };
      ws.onerror = () => {}; // onclose handles reconnect
    };

    // Resend the bbox after the camera settles (debounced).
    const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
      clearTimeout(sendTimer);
      sendTimer = setTimeout(sendBBox, 600);
    });

    connect();

    return () => {
      closed = true;
      removeMoveEnd();
      clearTimeout(sendTimer);
      try {
        ws?.close();
      } catch {
        // already closing
      }
    };
  };
}
