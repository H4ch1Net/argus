// CORS shim (proxy job 3). Many public feeds send no CORS headers, so the
// browser cannot read them directly. The proxy adds them.
//
// Feeds are read-only public data fetched with server-injected secrets, so the
// browser never needs to send credentials: we do NOT set
// Access-Control-Allow-Credentials, and defaulting to reflect-any-origin is
// safe for this data. Operators can pin an origin allowlist via config.

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{ allowAnyOrigin: boolean, origins: string[] }} policy
 * @returns {Record<string,string>}
 */
export function corsHeaders(req, policy) {
  const origin = req.headers.origin;
  const headers = {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Accept',
    'access-control-max-age': '600',
  };

  if (policy.allowAnyOrigin) {
    headers['access-control-allow-origin'] = origin || '*';
    headers['vary'] = 'Origin';
  } else if (origin && policy.origins.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  }
  // If the origin is not allowed, we simply omit the allow-origin header and the
  // browser blocks the read. The upstream request is not made for preflight.

  return headers;
}

/**
 * Answer a CORS preflight (OPTIONS) request.
 */
export function handlePreflight(req, res, policy) {
  res.writeHead(204, corsHeaders(req, policy));
  res.end();
}
