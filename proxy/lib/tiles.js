// Google Photorealistic 3D Tiles broker (proxy job 1: key broker, applied to a
// tile stream instead of a REST feed).
//
// The Google Maps Platform key is server-side only; the browser talks to
// /tiles/google/<path> and the proxy forwards to tile.googleapis.com with ?key=
// injected. The upstream host is pinned, so there is no SSRF surface (the client
// chooses only the sub-path, never the host).
//
// Google returns tileset JSON whose child/content URIs are root-absolute
// ("/v1/3dtiles/..."). Those would resolve against the proxy origin and lose the
// /tiles/google prefix, breaking traversal, so JSON responses are rewritten to
// keep the prefix. Binary tile content (glTF/GLB) passes through untouched.
//
// Without GOOGLE_MAPS_API_KEY the broker returns a clear 502 so the terrain
// toggle degrades honestly rather than appearing to work.

import { corsHeaders } from './cors.js';
import { sendJson } from './respond.js';

const GOOGLE_TILES_ORIGIN = 'https://tile.googleapis.com';
const PREFIX = '/tiles/google';

/**
 * Rewrite root-absolute Google tile URIs so they keep the /tiles/google prefix,
 * so Cesium follows children back through the proxy. Pure and unit-testable.
 * @param {string} text a tileset JSON body
 */
export function rewriteTilesetUris(text) {
  // Match "/v1/..." occurrences that are not already prefixed. Google's URIs all
  // begin at /v1/3dtiles; keeping this narrow avoids touching unrelated strings.
  return text.replace(/"\/v1\//g, `"${PREFIX}/v1/`);
}

/**
 * Handle a /tiles/google/... request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ config: object, env?: NodeJS.ProcessEnv }} ctx
 */
export async function handleGoogleTiles(req, res, { config, env = process.env }) {
  const cors = corsHeaders(req, config.cors);
  try {
    const key = env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      sendJson(
        res,
        502,
        { error: 'photorealistic tiles not configured: missing GOOGLE_MAPS_API_KEY' },
        cors,
      );
      return;
    }

    const url = new URL(req.url, 'http://proxy.local');
    const sub = url.pathname.slice(PREFIX.length) || '/';
    const target = new URL(GOOGLE_TILES_ORIGIN + sub);
    // Carry through the client query (e.g. session=...), then inject the key.
    for (const [k, v] of url.searchParams) target.searchParams.set(k, v);
    target.searchParams.set('key', key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let up;
    let buf;
    try {
      up = await fetch(target, {
        headers: { accept: req.headers['accept'] || '*/*' },
        signal: controller.signal,
        redirect: 'follow',
      });
      buf = Buffer.from(await up.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }

    const ct = up.headers.get('content-type') || '';
    // Rewrite tileset JSON so child URIs keep flowing through the proxy.
    if (ct.includes('json')) {
      buf = Buffer.from(rewriteTilesetUris(buf.toString('utf8')), 'utf8');
    }

    const outHeaders = { ...cors, 'content-length': buf.length };
    if (ct) outHeaders['content-type'] = ct;
    const cc = up.headers.get('cache-control');
    if (cc) outHeaders['cache-control'] = cc;

    res.writeHead(up.status, outHeaders);
    res.end(buf);
  } catch (err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 502, { error: `tiles upstream failed: ${err.name || 'error'}` }, cors);
  }
}
