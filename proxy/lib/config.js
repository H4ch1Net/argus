// Proxy configuration, loaded from the environment. No secrets live here; feed
// secrets are read by name from the environment at request time (see relay.js).

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  // 0 is allowed (an ephemeral port, used when another process embeds the proxy).
  const portNum = Number.parseInt(env.PROXY_PORT ?? '', 10);
  const port =
    Number.isInteger(portNum) && portNum >= 0 && portNum < 65536 ? portNum : 8787;
  // Bind address. Unset = every interface, so a phone on the LAN can reach it;
  // set PROXY_HOST=127.0.0.1 to keep the proxy (and your keys) local-only.
  const host = env.PROXY_HOST || null;
  // Optional directory holding the built web app, served from the same origin.
  const staticDir = env.PROXY_STATIC_DIR || null;
  const https = String(env.PROXY_HTTPS).toLowerCase() === 'true';
  const tls = {
    keyPath: env.PROXY_TLS_KEY || null,
    certPath: env.PROXY_TLS_CERT || null,
  };

  const originsRaw = (env.PROXY_ALLOWED_ORIGINS || '*').trim();
  const cors =
    originsRaw === '*'
      ? { allowAnyOrigin: true, origins: [] }
      : {
          allowAnyOrigin: false,
          origins: originsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        };

  const timeoutMs = Number(env.PROXY_UPSTREAM_TIMEOUT_MS) || 15000;

  return { port, host, staticDir, https, tls, cors, timeoutMs };
}

/**
 * Validate the feed registry at startup: unique ids and parseable base URLs.
 * Upstreams may be http (the plan requires reaching bare-IP / LAN feeds the
 * browser blocks), so protocol is intentionally not restricted here.
 * @param {import('../feeds.js').Feed[]} feeds
 */
export function validateFeeds(feeds) {
  const ids = new Set();
  for (const f of feeds) {
    if (!f.id) throw new Error('feed missing id');
    if (ids.has(f.id)) throw new Error(`duplicate feed id: ${f.id}`);
    ids.add(f.id);
    if (!f.baseUrl) throw new Error(`feed ${f.id} missing baseUrl`);
    if (!URL.canParse(f.baseUrl)) {
      throw new Error(`feed ${f.id} has invalid baseUrl: ${f.baseUrl}`);
    }
    // Mirrors are other public instances of the same API: never sent a
    // secret, never on this machine or the LAN, https only.
    if (f.mirrors) {
      if (f.inject?.length || f.auth || f.localOnly)
        throw new Error(`feed ${f.id}: mirrors cannot carry secrets or be local`);
      for (const m of f.mirrors) {
        if (!URL.canParse(m) || new URL(m).protocol !== 'https:')
          throw new Error(`feed ${f.id} has an invalid mirror: ${m}`);
      }
    }
    if (
      f.produce &&
      (typeof f.produce !== 'function' || (f.methods ?? ['GET']).join() !== 'GET')
    )
      throw new Error(`feed ${f.id}: produce must be a function on a GET-only feed`);
    if (f.timeoutMs != null && !(f.timeoutMs > 0))
      throw new Error(`feed ${f.id} has an invalid timeoutMs`);
  }
  return feeds;
}
