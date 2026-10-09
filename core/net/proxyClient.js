// Proxy client: the browser's half of the backbone. Every real feed is fetched
// through the proxy, addressed by feed id + sub-path (never a raw upstream URL).
//
// Pure and dependency-injected (baseUrl + fetchImpl) so it is unit-testable in
// Node without a browser or a running proxy. The app constructs it from
// import.meta.env.VITE_PROXY_BASE_URL (a non-secret).
//
// Each request may pass `onMeta` to hear what the proxy said about the answer
// (readMeta below): above all `stale`, the age in seconds of a last good body
// served because the upstream failed, so a layer can show STALE instead of an
// error. `tracked(onMeta)` is the same client with that hook on every request.

/**
 * What the proxy's headers say about a successful answer.
 * @returns {{ feedId: string, stale: number|null, cache: string|null,
 *   upstream: string|null, partial: boolean }}
 */
export function readMeta(feedId, res) {
  const get = (k) => res?.headers?.get?.(k) ?? null;
  const staleRaw = get('x-argus-stale');
  return {
    feedId,
    stale: staleRaw !== null && /^\d{1,9}$/.test(staleRaw) ? Number(staleRaw) : null,
    cache: get('x-argus-cache'),
    // A mirror answered instead of the feed's own upstream.
    upstream: get('x-argus-upstream'),
    // A body the proxy could only pass on as it came (e.g. a cut-off document).
    partial: get('x-argus-invalid') === '1',
  };
}

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

  async function request(feedId, path, { params, signal, onMeta } = {}, accept) {
    const res = await fetchImpl(buildUrl(feedId, path, params), {
      signal,
      headers: { accept },
    });
    if (!res.ok) throw await proxyError(feedId, res);
    try {
      onMeta?.(readMeta(feedId, res));
    } catch {
      // a listener's bug never fails the request
    }
    return res;
  }

  const client = {
    buildUrl,

    /**
     * GET JSON from a feed via the proxy.
     * @param {string} feedId
     * @param {string} path      sub-path under the feed, e.g. '/states/all'
     * @param {{ params?: Record<string, unknown>, signal?: AbortSignal,
     *   onMeta?: (meta: ReturnType<typeof readMeta>) => void }} [opts]
     */
    async getJson(feedId, path, opts) {
      return (await request(feedId, path, opts, 'application/json')).json();
    },

    /** GET plain text from a feed via the proxy (e.g. TLE data). */
    async getText(feedId, path, opts) {
      return (await request(feedId, path, opts, 'text/plain')).text();
    },

    /** GET raw bytes from a feed via the proxy (e.g. GTFS-RT protobuf). */
    async getBytes(feedId, path, opts) {
      const res = await request(
        feedId,
        path,
        opts,
        'application/x-protobuf, application/octet-stream',
      );
      return new Uint8Array(await res.arrayBuffer());
    },

    /**
     * This client with `onMeta` on every request (a layer's own copy, so the
     * app can tell which layer got a stale answer). A request's own onMeta
     * still runs.
     */
    tracked(onMeta) {
      const wrap =
        (fn) =>
        (feedId, path, opts = {}) =>
          fn(feedId, path, {
            ...opts,
            onMeta: (m) => {
              onMeta(m);
              opts.onMeta?.(m);
            },
          });
      return {
        ...client,
        getJson: wrap(client.getJson),
        getText: wrap(client.getText),
        getBytes: wrap(client.getBytes),
      };
    },
  };
  return client;
}

// The proxy answers its own failures with { error } (e.g. "feed firms not
// configured: missing FIRMS_MAP_KEY"); carry that reason so the readout and the
// terminal can say what is actually wrong, not just a status code.
async function proxyError(feedId, res) {
  let detail = '';
  try {
    const type = res.headers?.get?.('content-type') || '';
    if (type.includes('json')) detail = (await res.json())?.error || '';
  } catch {
    // no readable body
  }
  const err = new Error(
    `proxy ${feedId} responded ${res.status}${detail ? `: ${detail}` : ''}`,
  );
  err.status = res.status;
  return err;
}
