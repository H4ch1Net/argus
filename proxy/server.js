// Argus proxy: the backbone service. All six jobs (master plan 3.3 / CLAUDE.md):
//   1. Key / secret broker    - secrets injected server side, never reach the browser
//   2. OAuth2 token manager   - OpenSky client credentials (lib/oauth.js)
//   3. CORS shim              - adds CORS headers feeds omit
//   4. HTTPS terminator       - serves the browser over HTTPS (lib/createServer.js)
//   5. Stateful websockets    - AIS fan-out, plus the BGP and CT firehoses
//   6. Rate / budget governor - in front of every metered feed (lib/governor.js)
//
// Usage: node proxy/server.js [--https] [--port N] [--host ADDR] [--static DIR]
// Secrets come from the environment or a .env file (see lib/env.js).
//
// GUARDRAIL: the relay only reaches feeds listed in feeds.js. It reads
// already-public indexes; it never scans or sends traffic at a target.

import { loadEnvFiles } from './lib/env.js';
import { startProxy } from './lib/start.js';
import { lanAddresses } from './lib/createServer.js';

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const argv = process.argv.slice(2);
const envFiles = loadEnvFiles();

const opts = {};
// `--https` is a cross-platform alternative to PROXY_HTTPS=true.
if (argv.includes('--https')) opts.https = true;
if (argValue(argv, '--port') !== undefined) opts.port = Number(argValue(argv, '--port'));
if (argValue(argv, '--host') !== undefined) opts.host = argValue(argv, '--host');
if (argValue(argv, '--static') !== undefined) opts.staticDir = argValue(argv, '--static');

const proxy = await startProxy(opts);

const list = proxy.feeds.map((f) => f.id).join(', ') || 'none';
console.log(`[argus-proxy] listening on ${proxy.url}`);
if (!proxy.host) {
  for (const ip of lanAddresses()) {
    console.log(`[argus-proxy]   LAN: ${proxy.url.replace('localhost', ip)}`);
  }
}
console.log(`[argus-proxy] feeds: ${list}`);
console.log('[argus-proxy] ws: /ws/ais /ws/bgp /ws/ct   health: /health');
if (proxy.staticDir) console.log(`[argus-proxy] serving the app from ${proxy.staticDir}`);
console.log(
  `[argus-proxy] env files: ${envFiles.length ? envFiles.join(', ') : 'none found (keyless feeds only)'}`,
);

const shutdown = () => {
  proxy.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
