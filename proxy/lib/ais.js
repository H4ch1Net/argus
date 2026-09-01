import { WebSocketServer, WebSocket } from 'ws';

// Stateful AIS websocket consumer (proxy job 5). AISStream forbids direct
// browser connections, so the proxy holds ONE upstream connection and fans out
// only the ships each client needs. Verified Aug 2026: subscribe within 3s of
// connect, coordinates are [lat, lon], at most 1 subscription update/sec, and
// slow clients get dropped upstream. Compression (permessage-deflate) is on.
//
// Client protocol (browser <-> proxy):
//   client -> { type: 'bbox', bbox: { lamin, lomin, lamax, lomax } }
//   proxy  -> { type: 'ships', ships: [{ mmsi, name, lat, lon, cog, sog, heading }] }

const AISSTREAM_URL = 'wss://stream.aisstream.io/v0/stream';
const FLUSH_MS = 500;

export const inBBox = (b, lat, lon) =>
  lat >= b.lamin && lat <= b.lamax && lon >= b.lomin && lon <= b.lomax;

export function unionBBox(boxes) {
  if (boxes.length === 0) return { lamin: -90, lomin: -180, lamax: 90, lomax: 180 };
  return boxes.reduce((acc, b) => ({
    lamin: Math.min(acc.lamin, b.lamin),
    lomin: Math.min(acc.lomin, b.lomin),
    lamax: Math.max(acc.lamax, b.lamax),
    lomax: Math.max(acc.lomax, b.lomax),
  }));
}

/**
 * @param {import('node:http').Server} httpServer
 * @param {{ apiKey?: string }} opts
 */
export function attachAisWebsocket(httpServer, { apiKey }) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/ais',
    perMessageDeflate: true,
  });
  const clients = new Set(); // { ws, bbox, queue }

  let upstream = null;
  let upstreamReady = false;
  let reconnectDelay = 1000;
  let lastSubAt = 0;
  let resubTimer = null;

  function openUpstream() {
    if (!apiKey || upstream) return;
    upstream = new WebSocket(AISSTREAM_URL, { perMessageDeflate: true });
    upstream.on('open', () => {
      upstreamReady = true;
      reconnectDelay = 1000;
      scheduleSubscription();
    });
    upstream.on('message', handleUpstream);
    upstream.on('close', () => {
      upstreamReady = false;
      upstream = null;
      if (clients.size > 0) {
        setTimeout(openUpstream, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      }
    });
    upstream.on('error', () => {}); // 'close' handles reconnect
  }

  // AISStream allows at most one subscription update per second; debounce.
  function scheduleSubscription() {
    if (!upstreamReady) return;
    clearTimeout(resubTimer);
    const wait = Math.max(0, 1000 - (Date.now() - lastSubAt));
    resubTimer = setTimeout(() => {
      if (!upstreamReady) return;
      lastSubAt = Date.now();
      const box = unionBBox([...clients].map((c) => c.bbox).filter(Boolean));
      upstream.send(
        JSON.stringify({
          APIKey: apiKey,
          BoundingBoxes: [
            [
              [box.lamin, box.lomin],
              [box.lamax, box.lomax],
            ],
          ],
          FilterMessageTypes: ['PositionReport'],
        }),
      );
    }, wait);
  }

  function handleUpstream(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.MessageType !== 'PositionReport') return;
    const md = msg.MetaData || {};
    const pr = msg.Message?.PositionReport || {};
    const lat = typeof md.Latitude === 'number' ? md.Latitude : pr.Latitude;
    const lon = typeof md.Longitude === 'number' ? md.Longitude : pr.Longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    const ship = {
      mmsi: md.MMSI,
      name: (md.ShipName || '').trim(),
      lat,
      lon,
      cog: pr.Cog,
      sog: pr.Sog,
      heading: pr.TrueHeading,
    };
    for (const c of clients) {
      if (!c.bbox || inBBox(c.bbox, lat, lon)) c.queue.push(ship);
    }
  }

  // Batch each client's ships so a 300 msg/s feed becomes a few sends/sec.
  const flush = setInterval(() => {
    for (const c of clients) {
      if (c.queue.length && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ type: 'ships', ships: c.queue.splice(0) }));
      }
    }
  }, FLUSH_MS);
  flush.unref?.(); // a background flush must never keep the process alive

  wss.on('connection', (ws) => {
    const client = { ws, bbox: null, queue: [] };
    clients.add(client);
    openUpstream();
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (m.type === 'bbox' && m.bbox) {
          client.bbox = m.bbox;
          scheduleSubscription();
        }
      } catch {
        // ignore malformed client messages
      }
    });
    ws.on('close', () => {
      clients.delete(client);
      if (clients.size === 0 && upstream) {
        upstream.close();
        upstream = null;
      }
    });
  });

  wss.on('close', () => clearInterval(flush));
  return wss;
}
