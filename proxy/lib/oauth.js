// OAuth2 client-credentials token manager (proxy job 2).
//
// OpenSky (verified Aug 2026) requires OAuth2 client-credentials: POST
// client_id + client_secret (form-encoded) to the token endpoint, then send the
// access token as a Bearer header on every API request. Tokens last 30 minutes.
// We cache the token and refresh it ~30s before expiry so requests never race an
// expiry, and single-flight concurrent refreshes so a burst of requests triggers
// one token fetch, not many.
//
// The clock (`now`) and `fetchImpl` are injectable so this is unit-testable
// without real time or a real network.

/**
 * @param {object} opts
 * @param {string} opts.tokenUrl
 * @param {string} opts.clientId
 * @param {string} opts.clientSecret
 * @param {number} [opts.refreshSkewMs] refresh this long before expiry (default 30s)
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {() => number} [opts.now]
 */
export function createTokenManager({
  tokenUrl,
  clientId,
  clientSecret,
  refreshSkewMs = 30_000,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
}) {
  let cached = null; // { token: string, expiresAt: number }
  let inflight = null;

  async function fetchToken() {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    let res;
    try {
      res = await fetchImpl(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (err) {
      throw new Error(`token endpoint unreachable: ${err.name || err}`);
    }
    if (!res.ok) {
      // Consume/cancel the body so the underlying connection is released; an
      // unread error body leaks the socket and keeps the process alive.
      await res.body?.cancel?.().catch(() => {});
      throw new Error(`token endpoint returned ${res.status}`);
    }

    const json = await res.json();
    if (!json.access_token) throw new Error('token response missing access_token');

    const ttlSec = Number(json.expires_in) > 0 ? Number(json.expires_in) : 1800;
    cached = { token: json.access_token, expiresAt: now() + ttlSec * 1000 };
    return cached.token;
  }

  return {
    /** Return a valid token, refreshing (once, shared) if near expiry. */
    async getToken() {
      if (cached && now() < cached.expiresAt - refreshSkewMs) return cached.token;
      if (!inflight) {
        inflight = fetchToken().finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
    /** Drop the cached token so the next getToken refetches (used on a 401). */
    invalidate() {
      cached = null;
    },
    peek() {
      return cached;
    },
  };
}
