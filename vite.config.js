import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is opt-in via `npm run dev:https`. Serving to the phone over LAN needs
// HTTPS, or geolocation, orientation, and service workers silently no-op.
const httpsEnabled = process.env.HTTPS === 'true';

export default defineConfig({
  plugins: [cesium(), httpsEnabled ? basicSsl() : null].filter(Boolean),
  server: {
    // host:true exposes the dev server on the LAN so the S25 can reach it.
    host: true,
    port: 5173,
  },
});
