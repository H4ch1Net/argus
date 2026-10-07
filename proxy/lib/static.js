// Static file serving for the built web app (`dist/`), so ONE process serves the
// app and its proxy from the same origin. Same-origin is what makes the phone
// work over LAN without mixed-content or CORS trouble: open
// https://<machine>:8787 and both the globe and every feed come from there.
//
// Read-only and confined to the configured directory: the request path is
// decoded, normalized, and must stay inside the root, so `..` cannot escape it.

import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.ktx2': 'image/ktx2',
  '.b3dm': 'application/octet-stream',
  '.i3dm': 'application/octet-stream',
  '.pnts': 'application/octet-stream',
  '.cmpt': 'application/octet-stream',
  '.terrain': 'application/vnd.quantized-mesh',
};

export function contentTypeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

/**
 * Map a URL pathname to a file inside `root`, or null if it would escape root or
 * is malformed. Directory-ish paths map to their index.html.
 * @param {string} root  absolute directory
 * @param {string} pathname  URL pathname (still percent-encoded)
 */
export function resolveStaticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.endsWith('/') ? `${decoded}index.html` : decoded;
  const full = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(rootWithSep)) return null;
  return full;
}

/**
 * @param {string} dir  directory holding the built app
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => boolean}
 *          returns true if it handled the request
 */
export function createStaticHandler(dir) {
  const root = path.resolve(dir);

  return function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const file = resolveStaticPath(root, pathname);
    if (!file) return false;

    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const headers = {
      'content-type': contentTypeFor(file),
      'content-length': stat.size,
      'x-content-type-options': 'nosniff',
      // Vite emits content-hashed files under /assets/, safe to cache forever.
      // Everything else (index.html, sw.js, the manifest, Cesium statics) is
      // revalidated so a rebuild is picked up immediately.
      'cache-control': pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };
    // A service worker may control the whole origin only if served from the root.
    if (pathname === '/sw.js') headers['service-worker-allowed'] = '/';

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
    return true;
  };
}
