import { defineConfig, createLogger } from 'vite';
import cesium from 'vite-plugin-cesium';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFiles } from './proxy/lib/env.js';

// HTTPS is opt-in via `npm run dev:https`. Serving to the phone over LAN needs
// HTTPS, or geolocation, orientation, and service workers silently no-op.
const httpsEnabled = process.env.HTTPS === 'true';

// Same-origin proxy in dev: the dev server forwards the proxy's routes to a local
// Argus proxy, so the app reaches it from its own origin. That is what makes the
// phone work over LAN (an https page cannot call http://localhost:8787 on the
// laptop: wrong host and mixed content). The app probes /health at boot: proxy
// up means live feeds, proxy down means demo data. The target follows the
// proxy's own settings (PROXY_PORT / PROXY_HTTPS from the same .env files it
// reads); ARGUS_PROXY_TARGET overrides it, and ARGUS_PROXY_TARGET=off disables
// the forwarding entirely.
const proxyEnv = { ...process.env };
loadEnvFiles({ env: proxyEnv });
const proxyScheme =
  String(proxyEnv.PROXY_HTTPS).toLowerCase() === 'true' ? 'https' : 'http';
const target =
  proxyEnv.ARGUS_PROXY_TARGET ||
  `${proxyScheme}://localhost:${proxyEnv.PROXY_PORT || 8787}`;
const forward =
  target === 'off'
    ? undefined
    : {
        '/health': { target, changeOrigin: true, secure: false },
        '/feed/': { target, changeOrigin: true, secure: false },
        '/tiles/': { target, changeOrigin: true, secure: false },
        '/ws/': { target, ws: true, changeOrigin: true, secure: false },
      };

// With no proxy running, every forwarded request fails with ECONNREFUSED. That
// is the normal demo-data case, so log it once as a hint instead of a stack trace
// per request.
const logger = createLogger();
const logError = logger.error.bind(logger);
let hinted = false;
logger.error = (msg, options) => {
  const refused =
    typeof msg === 'string' &&
    msg.includes('proxy error') &&
    (options?.error?.code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED'));
  if (refused) {
    if (!hinted) {
      hinted = true;
      logger.warn(
        `[argus] no proxy at ${target}: the app runs on demo data. Start one with "npm run proxy" for live feeds.`,
      );
    }
    return;
  }
  logError(msg, options);
};

// Stamp the service worker (copied verbatim from public/) with a per-build id,
// so every build gets fresh caches and the shell, the hashed assets, and Cesium's
// statics can never come from two different builds.
function serviceWorkerBuildStamp() {
  let outDir = 'dist';
  return {
    name: 'argus-sw-build-stamp',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const file = path.join(outDir, 'sw.js');
      if (!fs.existsSync(file)) return;
      const stamp = Date.now().toString(36);
      fs.writeFileSync(
        file,
        fs.readFileSync(file, 'utf8').replaceAll('__ARGUS_BUILD__', stamp),
      );
    },
  };
}

export default defineConfig({
  customLogger: logger,
  plugins: [cesium(), serviceWorkerBuildStamp(), httpsEnabled ? basicSsl() : null].filter(
    Boolean,
  ),
  server: {
    // host:true exposes the dev server on the LAN so the S25 can reach it.
    host: true,
    port: 5173,
    proxy: forward,
  },
  preview: {
    host: true,
    proxy: forward,
  },
});
