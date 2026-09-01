// BGP push source: a websocket client to the proxy's /ws/bgp endpoint, which
// holds the upstream RIPE RIS Live connection and fans out sampled events. No
// subscription payload is needed; the proxy starts streaming on connect.
// Returns the SDK push-source signature: (onBatch) => unsubscribe.

/**
 * @param {{ wsUrl: string }} opts
 */
export function createRisSource({ wsUrl }) {
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
          if (m.type === 'bgp' && m.events?.length) onBatch(m.events);
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
