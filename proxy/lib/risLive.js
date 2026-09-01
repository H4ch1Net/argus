import { WebSocketServer, WebSocket } from 'ws';

// Stateful RIPE RIS Live websocket consumer (BGP firehose). Like the AIS consumer,
// the proxy holds ONE upstream connection and fans a bounded, SAMPLED stream out
// to browser clients, so a multi-thousand-msg/sec firehose becomes a lively but
// cheap pulse feed. Verified Aug 2026: wss://ris-live.ripe.net/v1/ws/, subscribe
// with { type:'ris_subscribe', data:{ type:'UPDATE' } }; each ris_message carries
// host (collector), peer_asn, path, announcements[], withdrawals[]. Public, no key.
//
// Client protocol (browser <-> proxy):
//   proxy -> { type: 'bgp', events: [{ id, rrc, kind: 'A'|'W', asn }] }

const RIS_URL = 'wss://ris-live.ripe.net/v1/ws/?client=argus';
const FLUSH_MS = 400;
const SAMPLE = 25; // process 1 in N upstream messages (bounds cost + downstream volume)
const QUEUE_CAP = 60; // most-recent events per client per flush

// Pure: turn a RIS Live frame into a compact event, or null to drop it.
export function risMessageToEvent(msg) {
  const d = msg?.data;
  if (!msg || msg.type !== 'ris_message' || !d) return null;
  if (d.type && d.type !== 'UPDATE') return null;
  const rrc = (String(d.host || '').match(/rrc\d+/i) || [])[0]?.toLowerCase();
  if (!rrc) return null;
  const announced = Array.isArray(d.announcements)
    ? d.announcements.reduce((n, a) => n + (a.prefixes?.length || 0), 0)
    : 0;
  const withdrawn = Array.isArray(d.withdrawals) ? d.withdrawals.length : 0;
  const kind = announced ? 'A' : withdrawn ? 'W' : null;
  if (!kind) return null;
  const path = Array.isArray(d.path) ? d.path : [];
  let origin = path.length ? path[path.length - 1] : d.peer_asn;
  if (Array.isArray(origin)) origin = origin[0]; // AS_SET at the origin
  return { rrc, kind, asn: origin ?? null };
}

export function attachRisWebsocket(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/bgp',
    perMessageDeflate: true,
  });
  const clients = new Set(); // { ws, queue }

  let upstream = null;
  let reconnectDelay = 1000;
  let seq = 0;
  let sampleCounter = 0;

  function openUpstream() {
    if (upstream) return;
    upstream = new WebSocket(RIS_URL, { perMessageDeflate: true });
    upstream.on('open', () => {
      reconnectDelay = 1000;
      upstream.send(JSON.stringify({ type: 'ris_subscribe', data: { type: 'UPDATE' } }));
    });
    upstream.on('message', handleUpstream);
    upstream.on('close', () => {
      upstream = null;
      if (clients.size > 0) {
        setTimeout(openUpstream, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
      }
    });
    upstream.on('error', () => {}); // 'close' handles reconnect
  }

  function handleUpstream(data) {
    if (sampleCounter++ % SAMPLE !== 0) return; // sample the firehose
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const ev = risMessageToEvent(msg);
    if (!ev) return;
    ev.id = seq++;
    for (const c of clients) {
      c.queue.push(ev);
      if (c.queue.length > QUEUE_CAP) c.queue.shift();
    }
  }

  const flush = setInterval(() => {
    for (const c of clients) {
      if (c.queue.length && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ type: 'bgp', events: c.queue.splice(0) }));
      }
    }
  }, FLUSH_MS);
  flush.unref?.();

  wss.on('connection', (ws) => {
    const client = { ws, queue: [] };
    clients.add(client);
    openUpstream();
    ws.on('close', () => {
      clients.delete(client);
      if (clients.size === 0 && upstream) {
        upstream.close();
        upstream = null;
      }
    });
    ws.on('error', () => {});
  });

  wss.on('close', () => clearInterval(flush));
  return wss;
}
