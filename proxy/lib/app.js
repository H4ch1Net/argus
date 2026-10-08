// Request router. Kept free of server/transport concerns so it can be tested by
// wrapping it in a plain http.createServer with an injected feed registry.

import { sendJson } from './respond.js';
import { handlePreflight } from './cors.js';
import { handleRelay, resolveBaseUrl } from './relay.js';
import { createResponseCache } from './cache.js';
import { handleGoogleTiles } from './tiles.js';

// A feed is "configured" (able to serve) when its credentials are actually present:
// an OAuth2 feed needs its token manager; a feed with injected secrets needs every
// required secret in the environment; a feed whose upstream exists only when the
// operator names it (localOnly, e.g. a home SDR receiver), or that an operator
// re-pointed, needs a valid URL there; a keyless feed is always configured.
function feedConfigured(feed, tokenManagers, env) {
  if (feed.auth?.type === 'oauth2') return Boolean(tokenManagers[feed.id]);
  if (!resolveBaseUrl(feed, env).ok) return false;
  const required = (feed.inject || []).filter((r) => r.required !== false);
  return required.every((r) => Boolean(env[r.secret]));
}

/**
 * @param {{ config: object, feeds: import('../feeds.js').Feed[], tokenManagers?: object, governor?: object, serveStatic?: Function, streams?: () => object }} ctx
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({
  config,
  feeds,
  tokenManagers = {},
  governor = null,
  serveStatic = null,
  streams = null,
  cache = createResponseCache(),
}) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://proxy.local');

      if (req.method === 'OPTIONS') {
        handlePreflight(req, res, config.cors);
        return;
      }
      if (url.pathname === '/health') {
        sendJson(res, 200, {
          status: 'ok',
          // Lets a client that probes its own origin (same-origin mode) confirm it
          // reached this proxy rather than some other server answering /health.
          service: 'argus-proxy',
          phase: 3,
          feeds: feeds.map((f) => ({
            id: f.id,
            // "configured" means the feed can actually serve: its OAuth2 token
            // manager exists, or every required injected secret is present. Keyless
            // feeds are always configured.
            configured: feedConfigured(f, tokenManagers, process.env),
            budget: governor?.usage(f.id) ?? undefined,
          })),
          // Websocket feeds: whether each endpoint is attached and has its key.
          streams: streams?.() ?? undefined,
        });
        return;
      }
      if (url.pathname.startsWith('/feed/')) {
        await handleRelay(req, res, { feeds, config, tokenManagers, governor, cache });
        return;
      }
      // Google Photorealistic 3D Tiles broker (key server-side; host-pinned).
      if (url.pathname.startsWith('/tiles/google')) {
        await handleGoogleTiles(req, res, { config });
        return;
      }
      // The built web app, when this proxy also serves it (same-origin mode).
      if (serveStatic?.(req, res, url.pathname)) return;
      sendJson(res, 404, { error: 'not found' });
    } catch {
      // Last-resort guard so a handler bug never crashes the process.
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
  };
}
