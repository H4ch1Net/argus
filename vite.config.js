import { defineConfig, createLogger } from 'vite';
import cesium from 'vite-plugin-cesium';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is opt-in via `npm run dev:https`. Serving to the phone over LAN needs
// HTTPS, or geolocation, orientation, and service workers silently no-op.
const httpsEnabled = process.env.HTTPS === 'true';

// Same-origin proxy in dev: the dev server forwards the proxy's routes to a local
// Argus proxy, so the app reaches it from its own origin. That is what makes the
// phone work over LAN (an https page cannot call http://localhost:8787 on the
// laptop: wrong host and mixed content). The app probes /health at boot: proxy
// up means live feeds, proxy down means demo data. ARGUS_PROXY_TARGET=off
// disables the forwarding entirely.
const target = process.env.ARGUS_PROXY_TARGET || 'http://localhost:8787';
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

export default defineConfig({
  customLogger: logger,
  plugins: [cesium(), httpsEnabled ? basicSsl() : null].filter(Boolean),
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
