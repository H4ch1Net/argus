// Start the proxy: the one entry point shared by `node proxy/server.js`, the
// `argus web` launcher (proxy + built app on one origin), and the terminal shell
// (which embeds a loopback-only proxy so its secrets stay server side too).
//
// GUARDRAIL: the relay only reaches feeds listed in feeds.js. It reads
// already-public indexes; it never scans or sends traffic at a target.

import { loadConfig, validateFeeds } from './config.js';
import { createRequestHandler } from './app.js';
import { createServer } from './createServer.js';
import { createTokenManager } from './oauth.js';
import { createGovernor } from './governor.js';
import { createStaticHandler } from './static.js';
import { feeds as feedRegistry } from '../feeds.js';

/**
 * Build OAuth2 token managers for feeds whose credentials are present. A feed
 * with OAuth2 config but unset credentials gets no manager and answers 502 until
 * configured, rather than failing startup.
 */
function buildTokenManagers(feeds, env, warn) {
  const managers = {};
  for (const f of feeds) {
    if (f.auth?.type !== 'oauth2') continue;
    const clientId = env[f.auth.clientId];
    const clientSecret = env[f.auth.clientSecret];
    if (clientId && clientSecret) {
      managers[f.id] = createTokenManager({
        tokenUrl: f.auth.tokenUrl,
        clientId,
        clientSecret,
      });
    } else {
      warn(
        `feed ${f.id}: ${f.auth.clientId} / ${f.auth.clientSecret} unset; it returns 502 until set`,
      );
    }
  }
  return managers;
}

/**
 * Attach the websocket consumers (AIS, BGP, CT). They need the `ws` package; if
 * it is not installed the HTTP relay still works and the push feeds are skipped.
 */
async function attachWebsockets(server, env, warn) {
  const attached = [];
  try {
    const [{ attachAisWebsocket }, { attachRisWebsocket }, { attachCtWebsocket }] =
      await Promise.all([
        import('./ais.js'),
        import('./risLive.js'),
        import('./certStream.js'),
      ]);
    const aisKey = env.AISSTREAM_API_KEY;
    attached.push(attachAisWebsocket(server, { apiKey: aisKey }));
    if (!aisKey) warn('AISSTREAM_API_KEY unset; /ws/ais carries no ships until set');
    attached.push(attachRisWebsocket(server));
    attached.push(
      attachCtWebsocket(server, env.CT_STREAM_URL ? { url: env.CT_STREAM_URL } : {}),
    );
  } catch (err) {
    warn(
      `websocket feeds disabled (${err.code === 'ERR_MODULE_NOT_FOUND' ? 'the ws package is not installed: run npm install' : err.message})`,
    );
  }
  return attached;
}

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]      environment (secrets are read from here)
 * @param {number} [opts.port]                overrides PROXY_PORT (0 = ephemeral)
 * @param {string|null} [opts.host]           overrides PROXY_HOST (bind address)
 * @param {boolean} [opts.https]              overrides PROXY_HTTPS
 * @param {string|null} [opts.staticDir]      serve a built web app from this directory
 * @param {boolean} [opts.websockets=true]    attach /ws/ais, /ws/bgp, /ws/ct
 * @param {(msg: string) => void} [opts.warn] where startup warnings go
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, wsUrl: string, https: boolean, feeds: object[], close: () => Promise<void> }>}
 */
export async function startProxy(opts = {}) {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m) => console.warn(`[argus-proxy] ${m}`));
  const config = loadConfig(env);
  if (opts.port !== undefined) config.port = opts.port;
  if (opts.host !== undefined) config.host = opts.host;
  if (opts.https !== undefined) config.https = Boolean(opts.https);
  if (opts.staticDir !== undefined) config.staticDir = opts.staticDir;

  const feeds = validateFeeds(feedRegistry);
  const tokenManagers = buildTokenManagers(feeds, env, warn);
  const governor = createGovernor(feeds);
  const serveStatic = config.staticDir ? createStaticHandler(config.staticDir) : null;

  let sockets = [];
  const streams = () => {
    const up = sockets.length > 0;
    return {
      ais: { available: up, configured: up && Boolean(env.AISSTREAM_API_KEY) },
      bgp: { available: up, configured: up },
      ct: { available: up, configured: up },
    };
  };
  const handler = createRequestHandler({
    config,
    feeds,
    tokenManagers,
    governor,
    serveStatic,
    streams,
  });
  const server = await createServer(handler, config);
  if (opts.websockets !== false) sockets = await attachWebsockets(server, env, warn);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    const done = () => {
      server.off('error', reject);
      resolve();
    };
    if (config.host) server.listen(config.port, config.host, done);
    else server.listen(config.port, done);
  });

  const port = server.address().port;
  const scheme = config.https ? 'https' : 'http';
  const localHost =
    !config.host || config.host === '0.0.0.0' || config.host === '::'
      ? 'localhost'
      : config.host;
  const url = `${scheme}://${localHost}:${port}`;

  return {
    server,
    port,
    url,
    wsUrl: url.replace(/^http/, 'ws'),
    https: config.https,
    host: config.host,
    staticDir: config.staticDir,
    feeds,
    close: async () => {
      for (const wss of sockets) {
        for (const client of wss.clients ?? []) client.terminate();
        await new Promise((r) => wss.close(() => r()));
      }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}
