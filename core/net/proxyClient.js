// Proxy client: the browser's half of the backbone. Every real feed is fetched
// through the proxy, addressed by feed id + sub-path (never a raw upstream URL).
//
// Pure and dependency-injected (baseUrl + fetchImpl) so it is unit-testable in
// Node without a browser or a running proxy. The app constructs it from
// import.meta.env.VITE_PROXY_BASE_URL (a non-secret).

/**
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch }} opts
 */
export function createProxyClient({ baseUrl, fetchImpl = (...a) => fetch(...a) }) {
  if (!baseUrl) throw new Error('createProxyClient: baseUrl is required');
  const root = baseUrl.replace(/\/+$/, '');

  function buildUrl(feedId, path = '/', params) {
    const p = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${root}/feed/${encodeURIComponent(feedId)}${p}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  return {
    buildUrl,

    /**
     * GET JSON from a feed via the proxy.
     * @param {string} feedId
     * @param {string} path      sub-path under the feed, e.g. '/states/all'
     * @param {{ params?: Record<string, unknown>, signal?: AbortSignal }} [opts]
     */
    async getJson(feedId, path, { params, signal } = {}) {
      const res = await fetchImpl(buildUrl(feedId, path, params), {
        signal,
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw proxyError(feedId, res.status);
      return res.json();
    },

    /** GET plain text from a feed via the proxy (e.g. TLE data). */
    async getText(feedId, path, { params, signal } = {}) {
      const res = await fetchImpl(buildUrl(feedId, path, params), {
        signal,
        headers: { accept: 'text/plain' },
      });
      if (!res.ok) throw proxyError(feedId, res.status);
      return res.text();
    },
  };
}

function proxyError(feedId, status) {
  const err = new Error(`proxy ${feedId} responded ${status}`);
  err.status = status;
  return err;
}
