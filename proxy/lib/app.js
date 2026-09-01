// Request router. Kept free of server/transport concerns so it can be tested by
// wrapping it in a plain http.createServer with an injected feed registry.

import { sendJson } from './respond.js';
import { handlePreflight } from './cors.js';
import { handleRelay } from './relay.js';
import { handleGoogleTiles } from './tiles.js';

/**
 * @param {{ config: object, feeds: import('../feeds.js').Feed[], tokenManagers?: object }} ctx
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({
  config,
  feeds,
  tokenManagers = {},
  governor = null,
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
          phase: 3,
          feeds: feeds.map((f) => ({
            id: f.id,
            // A feed needing OAuth2 is "configured" only once its token manager exists.
            configured: f.auth?.type === 'oauth2' ? Boolean(tokenManagers[f.id]) : true,
            budget: governor?.usage(f.id) ?? undefined,
          })),
        });
        return;
      }
      if (url.pathname.startsWith('/feed/')) {
        await handleRelay(req, res, { feeds, config, tokenManagers, governor });
        return;
      }
      // Google Photorealistic 3D Tiles broker (key server-side; host-pinned).
      if (url.pathname.startsWith('/tiles/google')) {
        await handleGoogleTiles(req, res, { config });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch {
      // Last-resort guard so a handler bug never crashes the process.
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
  };
}
