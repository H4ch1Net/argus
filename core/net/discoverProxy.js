// Find the proxy the app should talk to. Pure over an injected fetch, so it is
// unit-testable in Node.
//
// Order:
//   1. VITE_PROXY_BASE_URL, when set (a proxy on another origin; not a secret).
//   2. The app's own origin, when it answers /health as an Argus proxy. That is
//      the case both when the proxy serves the built app (`npm start`) and when
//      the Vite dev server forwards the proxy routes (vite.config.js).
//   3. None: dev falls back to labelled demo data, production says so plainly.
//
// The /health body is returned too, so callers can see which feeds have their
// keys configured (e.g. to pick a keyless flights source when OpenSky has none).

/**
 * @param {{ explicit?: string|null, origin?: string|null, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<{ base: string|null, health: object|null }>}
 */
export async function discoverProxy({
  explicit = null,
  origin = null,
  fetchImpl = (...a) => fetch(...a),
  timeoutMs = 2500,
} = {}) {
  const candidates = [explicit, origin]
    .filter(Boolean)
    .map((b) => String(b).replace(/\/+$/, ''));
  for (const base of candidates) {
    const health = await probe(base, fetchImpl, timeoutMs);
    if (health) return { base, health };
    // An explicitly configured proxy is used even if it is down right now: layers
    // then show an honest error instead of silently switching to demo data.
    if (base === explicit?.replace(/\/+$/, '')) return { base, health: null };
  }
  return { base: null, health: null };
}

async function probe(base, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/health`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return isArgusHealth(body) ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** True when a /health body came from an Argus proxy (not some other server). */
export function isArgusHealth(body) {
  return Boolean(
    body &&
    body.status === 'ok' &&
    Array.isArray(body.feeds) &&
    (body.service === 'argus-proxy' || body.service === undefined),
  );
}

/** Whether the proxy reports a feed as able to serve (its keys are set). */
export function feedConfigured(health, id) {
  return Boolean(health?.feeds?.find((f) => f.id === id)?.configured);
}
