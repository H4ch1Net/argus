// HTTPS terminator (proxy job 4). Mobile hard-blocks HTTP feeds, so the browser
// must reach the proxy over HTTPS. In production, pass real cert paths
// (PROXY_TLS_KEY / PROXY_TLS_CERT). For local phone-over-LAN testing with no
// cert on hand, an in-memory self-signed cert is generated on demand, mirroring
// the app's own `dev:https`.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

/**
 * @param {Function} handler
 * @param {{ https: boolean, tls: { keyPath: string|null, certPath: string|null } }} config
 * @returns {Promise<import('node:http').Server | import('node:https').Server>}
 */
export async function createServer(handler, config) {
  if (!config.https) return http.createServer(handler);
  const creds = await resolveTls(config.tls);
  return https.createServer(creds, handler);
}

async function resolveTls(tls) {
  if (tls.keyPath && tls.certPath) {
    return { key: fs.readFileSync(tls.keyPath), cert: fs.readFileSync(tls.certPath) };
  }
  // Dev fallback. selfsigned is imported lazily so plain-HTTP mode needs no dep.
  const { default: selfsigned } = await import('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], {
    days: 365,
    keySize: 2048,
    altNames: [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
    ],
  });
  return { key: pems.private, cert: pems.cert };
}
