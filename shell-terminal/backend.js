// Where the terminal shell gets its data. Same rule as the browser: every feed
// goes through the proxy, so secrets live in exactly one place.
//
//   embedded (default)  start a proxy inside this process on 127.0.0.1 with an
//                       ephemeral port; it reads .env like the standalone proxy
//   remote (--proxy)    use a proxy that is already running elsewhere
//   demo (--demo)       no network at all: core's labelled dev mocks

import { createProxyClient } from '../core/net/proxyClient.js';
import { discoverProxy } from '../core/net/discoverProxy.js';
import { ensureWebSocket } from './viewerAdapter.js';

/**
 * @param {{ proxyUrl?: string|null, demo?: boolean, warn?: (m: string) => void }} opts
 */
export async function connectBackend({
  proxyUrl = null,
  demo = false,
  warn = () => {},
} = {}) {
  const wsReady = await ensureWebSocket();
  if (!wsReady) warn('no WebSocket client available: ships, BGP and CT streams are off');

  if (demo) {
    const [{ createMockLookup, createMockCorrelator }, { createMockGeocoder }] =
      await Promise.all([
        import('../core/osint/mockLookup.js'),
        import('../core/search/mockGeocoder.js'),
      ]);
    return {
      mode: 'demo',
      label: 'offline (no network)',
      client: null,
      wsBase: null,
      health: null,
      lookup: createMockLookup(),
      correlate: createMockCorrelator(),
      geocode: createMockGeocoder(),
      envFiles: [],
      close: async () => {},
    };
  }

  let base;
  let close = async () => {};
  let envFiles = [];
  if (proxyUrl) {
    base = proxyUrl.replace(/\/+$/, '');
  } else {
    const [{ loadEnvFiles }, { startProxy }] = await Promise.all([
      import('../proxy/lib/env.js'),
      import('../proxy/lib/start.js'),
    ]);
    envFiles = loadEnvFiles();
    // Loopback only: this proxy exists for this process, not the LAN.
    const proxy = await startProxy({
      port: 0,
      host: '127.0.0.1',
      https: false,
      staticDir: null,
      websockets: wsReady,
      warn,
    });
    base = proxy.url;
    close = proxy.close;
  }

  const client = createProxyClient({ baseUrl: base });
  const { health } = await discoverProxy({ explicit: base });
  if (!health)
    warn(`proxy at ${base} is not answering /health; feeds will report errors`);

  const [{ createLookup }, { createCorrelator }, { createGeocoder }] = await Promise.all([
    import('../core/osint/lookup.js'),
    import('../core/osint/correlate.js'),
    import('../core/search/geocoder.js'),
  ]);

  return {
    mode: proxyUrl ? 'remote' : 'embedded',
    label: proxyUrl ? `proxy ${base}` : 'embedded proxy (loopback)',
    client,
    wsBase: wsReady ? base.replace(/^http/, 'ws') : null,
    health,
    lookup: createLookup(client),
    correlate: createCorrelator({ proxyClient: client }),
    geocode: createGeocoder(client),
    envFiles,
    close,
  };
}
