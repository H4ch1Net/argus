// CT push source: a websocket client to the proxy's /ws/ct endpoint, which holds
// the upstream CertStream connection and fans out sampled cert events. No
// subscription payload is needed. Returns the push signature: (onBatch) => stop.

/**
 * @param {{ wsUrl: string }} opts
 */
export function createCtSource({ wsUrl }) {
  return (onBatch) => {
    let ws = null;
    let closed = false;
    let delay = 1000;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        delay = 1000;
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'ct' && m.certs?.length) onBatch(m.certs);
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
      ws.onerror = () => {};
    };

    connect();

    return () => {
      closed = true;
      try {
        ws?.close();
      } catch {
        // already closing
      }
    };
  };
}
