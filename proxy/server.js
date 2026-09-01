// Argus proxy v1 (Phase 2): the backbone service.
//
// Implemented this phase (master plan 3.3 / CLAUDE.md):
//   1. Key / secret broker   - secrets injected server side, never reach the browser
//   3. CORS shim             - adds CORS headers feeds omit
//   4. HTTPS terminator      - serves the browser over HTTPS (see createServer.js)
//
// Not yet (later phases, deliberately not scaffolded here):
//   2. OAuth2 token manager  - Phase 3, with OpenSky
//   5. AIS websocket consumer - Phase 10
//   6. Rate / budget governor - Phase 13
//
// GUARDRAIL: the relay only reaches feeds listed in feeds.js (currently none).
// It reads already-public indexes; it never scans or sends traffic at a target.

import { loadConfig, validateFeeds } from './lib/config.js';
import { createRequestHandler } from './lib/app.js';
import { createServer } from './lib/createServer.js';
import { createTokenManager } from './lib/oauth.js';
import { feeds as feedRegistry } from './feeds.js';

const config = loadConfig();
// `--https` is a cross-platform alternative to PROXY_HTTPS=true.
if (process.argv.includes('--https')) config.https = true;

const feeds = validateFeeds(feedRegistry);

// Build a token manager for each OAuth2 feed whose credentials are present.
// A feed with OAuth2 config but unset credentials is left without a manager and
// responds 502 until configured, rather than failing startup.
const tokenManagers = {};
for (const f of feeds) {
  if (f.auth?.type !== 'oauth2') continue;
  const clientId = process.env[f.auth.clientId];
  const clientSecret = process.env[f.auth.clientSecret];
  if (clientId && clientSecret) {
    tokenManagers[f.id] = createTokenManager({
      tokenUrl: f.auth.tokenUrl,
      clientId,
      clientSecret,
    });
  } else {
    console.warn(
      `[argus-proxy] feed ${f.id}: OAuth2 configured but ${f.auth.clientId} / ${f.auth.clientSecret} are unset; it will return 502 until set`,
    );
  }
}

const { createGovernor } = await import('./lib/governor.js');
const governor = createGovernor(feeds);

const handler = createRequestHandler({ config, feeds, tokenManagers, governor });
const server = await createServer(handler, config);

// AIS websocket consumer (job 5). Attaches at /ws/ais. Without an API key the
// endpoint accepts clients but has no upstream, so it simply sends no ships.
const aisKey = process.env.AISSTREAM_API_KEY;
const { attachAisWebsocket } = await import('./lib/ais.js');
attachAisWebsocket(server, { apiKey: aisKey });
if (!aisKey) {
  console.warn(
    '[argus-proxy] AISSTREAM_API_KEY unset; /ws/ais has no ship data until set',
  );
}

// BGP firehose (RIPE RIS Live). Public, no key: attaches at /ws/bgp and holds one
// sampled upstream connection while any client is subscribed.
const { attachRisWebsocket } = await import('./lib/risLive.js');
attachRisWebsocket(server);

// Certificate Transparency firehose. Attaches at /ws/ct; upstream from CT_STREAM_URL
// (defaults to public CertStream, which is often silent). No key.
const { attachCtWebsocket } = await import('./lib/certStream.js');
attachCtWebsocket(server);

server.listen(config.port, () => {
  const scheme = config.https ? 'https' : 'http';
  const list = feeds.map((f) => f.id).join(', ') || 'none';
  console.log(
    `[argus-proxy] v1 listening on ${scheme}://localhost:${config.port} (feeds: ${list}, ws: /ws/ais + /ws/bgp + /ws/ct, health: /health)`,
  );
});
