// HTTPS terminator (proxy job 4). Mobile hard-blocks HTTP feeds, so the browser
// must reach the proxy over HTTPS. In production, pass real cert paths
// (PROXY_TLS_KEY / PROXY_TLS_CERT, e.g. from mkcert). For local phone-over-LAN
// use with no cert on hand, a self-signed cert is generated once and kept under
// ~/.config/argus/tls, so the phone only has to accept it once instead of after
// every restart. It names localhost plus this machine's LAN addresses, and is
// regenerated when those addresses change.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** Read the interfaces, tolerating platforms that forbid it (Android/Termux). */
function readInterfaces() {
  try {
    return os.networkInterfaces();
  } catch {
    // Android's sandbox blocks the netlink query behind os.networkInterfaces()
    // (uv_interface_addresses fails with EACCES); carry on without LAN addresses.
    return {};
  }
}

/** Non-internal IPv4 addresses of this machine (what a phone on the LAN would use). */
export function lanAddresses(ifaces = readInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (v4 && !a.internal) out.push(a.address);
    }
  }
  return [...new Set(out)].sort();
}

function tlsCacheDir(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'argus', 'tls');
}

async function resolveTls(tls) {
  if (tls.keyPath && tls.certPath) {
    return { key: fs.readFileSync(tls.keyPath), cert: fs.readFileSync(tls.certPath) };
  }

  const names = ['localhost', os.hostname()].filter(Boolean);
  const ips = ['127.0.0.1', ...lanAddresses()];
  const wanted = JSON.stringify({ names, ips });

  const dir = tlsCacheDir();
  const files = {
    key: path.join(dir, 'key.pem'),
    cert: path.join(dir, 'cert.pem'),
    meta: path.join(dir, 'meta.json'),
  };
  try {
    if (fs.readFileSync(files.meta, 'utf8') === wanted) {
      return { key: fs.readFileSync(files.key), cert: fs.readFileSync(files.cert) };
    }
  } catch {
    // no cached cert yet (or unreadable): generate one below
  }

  // selfsigned is imported lazily so plain-HTTP mode needs no dependency.
  const { default: selfsigned } = await import('selfsigned');
  const pems = selfsigned.generate([{ name: 'commonName', value: 'argus.local' }], {
    days: 825,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          ...names.map((value) => ({ type: 2, value })),
          ...ips.map((ip) => ({ type: 7, ip })),
        ],
      },
    ],
  });

  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(files.key, pems.private, { mode: 0o600 });
    fs.writeFileSync(files.cert, pems.cert);
    fs.writeFileSync(files.meta, wanted);
  } catch {
    // Read-only home or similar: still serve, just regenerate next time.
  }
  return { key: pems.private, cert: pems.cert };
}
