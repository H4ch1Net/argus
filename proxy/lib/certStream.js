import { WebSocketServer, WebSocket } from 'ws';

// Certificate Transparency firehose consumer (CT/BGP stage). Like the AIS and RIS
// consumers, the proxy holds ONE upstream connection to a CertStream aggregator
// and fans a sampled, bounded stream of newly issued certs out to browser clients.
// "The internet building itself in real time." CT has no per-cert geography, so
// the client renders this as a live issuance ticker, not globe points.
//
// NOTE: the public CertStream server (wss://certstream.calidog.io/) frequently
// accepts connections but streams nothing; treat it as unverified. The protocol
// below is correct, so a working aggregator (or a self-hosted CertStream) drops
// straight in via CT_STREAM_URL; until then dev uses a synthetic stream.
//
// Client protocol (browser <-> proxy):
//   proxy -> { type: 'ct', certs: [{ id, domain, domains, ca }] }

const DEFAULT_URL = 'wss://certstream.calidog.io/';
const FLUSH_MS = 500;
const SAMPLE = 8; // process 1 in N upstream messages
const QUEUE_CAP = 40;

// Pure: turn a CertStream frame into a compact cert event, or null to drop it.
export function certMessageToEvent(msg) {
  if (!msg || msg.message_type !== 'certificate_update') return null;
  const lc = msg.data?.leaf_cert;
  const domains = Array.isArray(lc?.all_domains) ? lc.all_domains : [];
  if (!domains.length) return null;
  const ca = lc.issuer?.O || lc.issuer?.CN || 'unknown CA';
  return {
    domain: String(domains[0]),
    domains: domains.length,
    ca: String(ca).slice(0, 60),
  };
}

export function attachCtWebsocket(
  httpServer,
  { url = process.env.CT_STREAM_URL || DEFAULT_URL } = {},
) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws/ct',
    perMessageDeflate: true,
  });
  const clients = new Set(); // { ws, queue }

  let upstream = null;
  let reconnectDelay = 1000;
  let seq = 0;
  let sampleCounter = 0;

  function openUpstream() {
    if (upstream) return;
    upstream = new WebSocket(url, { perMessageDeflate: true });
    upstream.on('open', () => {
      reconnectDelay = 1000;
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
    if (sampleCounter++ % SAMPLE !== 0) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const ev = certMessageToEvent(msg);
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
        c.ws.send(JSON.stringify({ type: 'ct', certs: c.queue.splice(0) }));
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
