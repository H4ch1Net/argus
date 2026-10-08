// Argus proxy entry for the Android app. The app embeds Node (nodejs-mobile,
// Node 18) and runs this file on a background thread: it starts the same proxy
// as `argus web`, serving the built globe (./dist) and every feed on one
// loopback origin, then writes the port it got to ARGUS_PORT_FILE so the app
// knows where to point its WebViews. scripts/android-bundle.mjs copies it to
// the root of the staged Node project as main.js.
//
// Never call process.exit here: Node shares the app's process, so exiting
// closes the app. Errors are logged and the proxy keeps running. Only Node
// builtins are imported statically; the proxy is imported inside try/catch, so
// even a module that fails to load is reported instead of killing the app.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const LOG_MAX_BYTES = 512 * 1024;
const PORT_TRIES = 20;

// --------------------------------------------------------------------- log
// Everything Node prints also goes to logcat (native-lib.cpp); the file is for
// the app's settings screen and error page, where there is no adb.
const logFile = env.ARGUS_LOG_FILE || null;
let logBytes = 0;
if (logFile) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, '');
  } catch {
    // no log file: logcat still has everything
  }
}
function writeLog(level, args) {
  if (!logFile) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}\n`;
  try {
    if (logBytes + line.length > LOG_MAX_BYTES) {
      fs.writeFileSync(logFile, '[log truncated]\n');
      logBytes = 0;
    }
    fs.appendFileSync(logFile, line);
    logBytes += line.length;
  } catch {
    // a full disk must not take the proxy down
  }
}
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    writeLog(level, args);
  };
}

process.on('uncaughtException', (err) => {
  console.error('[argus-android] uncaught exception:', err?.stack || err);
});
process.on('unhandledRejection', (err) => {
  console.error('[argus-android] unhandled rejection:', err?.stack || err);
});

// ------------------------------------------------------------------- start
/** True when nothing listens on host:port yet. */
function portFree(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/** The first free port from `first`, else 0 (the OS picks one). */
async function choosePort(first, host) {
  for (let i = 0; i < PORT_TRIES; i += 1) {
    const port = first + i;
    if (port > 65535) break;
    if (await portFree(port, host)) return port;
  }
  return 0;
}

async function main() {
  const { loadEnvFiles } = await import('./proxy/lib/env.js');
  const { startProxy } = await import('./proxy/lib/start.js');

  // Keys: ARGUS_ENV_FILE (the app's private keys file) first. Values the app
  // set in the environment (port, host) always win over the file.
  const envFiles = loadEnvFiles();

  // Loopback unless the user switched on LAN sharing in the app's settings.
  const host = env.PROXY_HOST === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  const wanted = Number.parseInt(env.PROXY_PORT ?? '', 10);
  const first = Number.isInteger(wanted) && wanted > 0 && wanted < 65536 ? wanted : 8787;
  const port = await choosePort(first, host);

  const proxy = await startProxy({
    host,
    port,
    // Plain HTTP on loopback: the WebView treats 127.0.0.1 as a secure
    // origin, so location and the service worker work without a certificate.
    https: false,
    staticDir: path.join(here, 'dist'),
  });

  if (env.ARGUS_PORT_FILE) fs.writeFileSync(env.ARGUS_PORT_FILE, `${proxy.port}\n`);
  console.log(`[argus-android] Node ${process.version} on ${process.platform}/${process.arch}`);
  console.log(`[argus-android] proxy and globe at http://127.0.0.1:${proxy.port}/`);
  if (host === '0.0.0.0') console.log('[argus-android] shared on the LAN (settings)');
  console.log(
    `[argus-android] feeds: ${proxy.feeds.map((f) => f.id).join(', ') || 'none'}`,
  );
  console.log(
    `[argus-android] keys from: ${envFiles.length ? envFiles.join(', ') : 'none yet (keyless feeds only)'}`,
  );
}

main().catch((err) => {
  // The app's health check times out and shows this log.
  console.error('[argus-android] the proxy failed to start:', err?.stack || err);
});
