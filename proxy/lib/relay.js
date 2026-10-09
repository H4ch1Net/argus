// The relay: proxy jobs 1 (key broker) and 3 (CORS) for a single upstream feed.
//
// Flow: /feed/<id>/<subpath> -> look up <id> in the registry -> validate method
// and path -> inject server-side secrets -> fetch the upstream -> return the
// body with CORS headers. The client cannot choose the host (only the feed id),
// and the sub-path cannot escape the feed's configured base path, so there is no
// open-proxy / SSRF surface.
//
// Reliability: each attempt has the feed's own timeout (`timeoutMs`, else the
// proxy default); a feed may list `mirrors` (other instances of the same API,
// tried in order when one fails or times out, a failing one going last for a
// few minutes), `retries` on the same host, and a `validate` check for a 200
// that is not really an answer (a truncated document, an Overpass timeout).
// When everything fails, a cached feed answers with its last good body and
// `x-argus-stale: <age seconds>` so the client can show STALE, not an error.
// A `produce` feed builds its body here from pinned upstream files (GDELT).

import { corsHeaders } from './cors.js';
import { readBody, sendJson } from './respond.js';

export class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Resolve the upstream URL for a feed + client sub-path, refusing anything that
 * escapes the feed's base origin or base path.
 * @param {import('../feeds.js').Feed} feed
 * @param {string} subpath   path after /feed/<id>, always starts with '/'
 * @param {string} search    query string including leading '?', or ''
 * @returns {URL}
 */
export function buildUpstreamUrl(feed, subpath, search) {
  const base = new URL(feed.baseUrl);
  const basePath = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
  const rel = subpath.replace(/^\/+/, '');
  const target = new URL(rel + (search || ''), `${base.origin}${basePath}`);

  if (target.origin !== base.origin) {
    throw new RelayError(400, 'resolved target escapes feed origin');
  }
  const baseNoTrailing = base.pathname.replace(/\/+$/, '');
  if (baseNoTrailing && !target.pathname.startsWith(baseNoTrailing)) {
    throw new RelayError(400, 'resolved path escapes feed base path');
  }
  return target;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Request headers minus anything that carries a credential. */
function withoutSecrets(headers, feed) {
  const drop = new Set(['authorization', 'proxy-authorization', 'cookie']);
  for (const rule of feed.inject ?? [])
    if (rule.as === 'header') drop.add(rule.name.toLowerCase());
  return Object.fromEntries(
    Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())),
  );
}
const MAX_REDIRECTS = 4;

// Every relayed body is data, never a page: the browser must not sniff it into
// HTML, and if it is ever opened directly it runs sandboxed with nothing
// allowed. The proxy serves the app on the same origin, so this matters.
const SAFE_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
});

/** A host this machine or its network answers: loopback, LAN, link-local. */
export function isPrivateHost(hostname) {
  const h = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === '::' || /^0\./.test(h)) return true; // unspecified, "this network"
  // IPv4-mapped IPv6 (::ffff:127.0.0.1, which URL writes as ::ffff:7f00:1).
  const mapped = /^::ffff:(.+)$/.exec(h);
  if (mapped) {
    const v4 = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped[1]);
    const dotted = v4
      ? [
          parseInt(v4[1], 16) >> 8,
          parseInt(v4[1], 16) & 255,
          parseInt(v4[2], 16) >> 8,
          parseInt(v4[2], 16) & 255,
        ].join('.')
      : mapped[1];
    return isPrivateHost(dotted);
  }
  return isLocalHost(h) || /^169\.254\./.test(h) || /^fe80:/.test(h);
}

/** Loopback, RFC 1918 IPv4, IPv6 loopback / unique-local, localhost, *.local. */
export function isLocalHost(hostname) {
  const h = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || h === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // IPv6 unique local
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

/**
 * The upstream base URL a feed uses right now: its own, or the operator's
 * override from `baseUrlEnv`. A localOnly feed (equipment you own, such as an
 * SDR receiver) has no upstream until the override names a host on this
 * machine or the LAN. Shared by the relay and /health, so a feed is reported
 * configured only when it can actually serve.
 * @returns {{ ok: true, baseUrl: string, overridden: boolean } | { ok: false, reason: string }}
 */
export function resolveBaseUrl(feed, env = process.env) {
  const override = feed.baseUrlEnv ? env[feed.baseUrlEnv] : null;
  if (!override) {
    return feed.localOnly
      ? { ok: false, reason: `feed ${feed.id} not configured: set ${feed.baseUrlEnv}` }
      : { ok: true, baseUrl: feed.baseUrl, overridden: false };
  }
  if (!URL.canParse(override)) {
    return { ok: false, reason: `${feed.baseUrlEnv} is not a valid URL` };
  }
  if (feed.localOnly && !isLocalHost(new URL(override).hostname)) {
    return {
      ok: false,
      reason: `${feed.baseUrlEnv} must point at this machine or the LAN`,
    };
  }
  return { ok: true, baseUrl: override, overridden: true };
}

/**
 * The path the allowlist judges: with an override, the upstream path is
 * re-based onto the feed's default base path, so `allowPaths` stays anchored
 * (e.g. ^/api/interpreter$) whatever prefix the operator's instance uses.
 */
function allowlistPath(feed, baseUrl, pathname) {
  const strip = (u) => new URL(u).pathname.replace(/\/+$/, '');
  return strip(feed.baseUrl) + pathname.slice(strip(baseUrl).length);
}

function matchAllow(patterns, pathname) {
  return patterns.some((p) =>
    p instanceof RegExp ? p.test(pathname) : pathname.startsWith(p),
  );
}

function resolveSecret(feed, rule, env) {
  const raw = env[rule.secret];
  if (raw == null || raw === '') {
    if (rule.required !== false) {
      throw new RelayError(502, `feed ${feed.id} not configured: missing ${rule.secret}`);
    }
    return null;
  }
  return raw;
}

function injectSecrets(feed, target, headers, env) {
  for (const rule of feed.inject || []) {
    if (rule.as === 'pathPrefix') continue; // handled before the URL is built
    const raw = resolveSecret(feed, rule, env);
    if (raw == null) continue;
    const value = (rule.template || '{value}').replace('{value}', raw);
    if (rule.as === 'header') headers[rule.name.toLowerCase()] = value;
    else if (rule.as === 'query') target.searchParams.set(rule.name, value);
  }
}

// Some APIs put the key in the URL path (e.g. NASA FIRMS). Prepend those path
// segments to the client sub-path before the upstream URL is built.
function applyPathPrefix(feed, subpath, env) {
  let prefix = '';
  for (const rule of feed.inject || []) {
    if (rule.as !== 'pathPrefix') continue;
    const raw = resolveSecret(feed, rule, env);
    if (raw == null) continue;
    prefix += `/${encodeURIComponent(raw)}`;
  }
  const rel = subpath.startsWith('/') ? subpath : `/${subpath}`;
  return prefix ? prefix + rel : rel;
}

// A base that failed (network error, timeout, 429, 5xx) goes to the back of its
// feed's mirror list for this long, so a dead primary does not cost its whole
// timeout on every request.
export const MIRROR_COOLDOWN_MS = 5 * 60_000;

/**
 * The bases a request may use, in configured order: the operator's override
 * (or the feed's own base), then, for a feed with mirrors, the feed's own base
 * (when overridden) and each mirror. Without mirrors an override replaces the
 * feed's base, as it always did.
 */
export function upstreamBases(feed, base) {
  const list = [base.baseUrl];
  if (feed.mirrors?.length) {
    if (base.overridden) list.push(feed.baseUrl);
    list.push(...feed.mirrors);
  }
  return [...new Set(list)];
}

/** Healthy bases first (in their order), then the ones cooling down. */
export function orderByHealth(bases, health, now = Date.now()) {
  if (bases.length < 2 || !health) return bases;
  const cooling = (b) => (health.get(b) ?? 0) > now;
  return [...bases.filter((b) => !cooling(b)), ...bases.filter(cooling)];
}

/** Read a fetch body, refusing one larger than maxBytes. */
async function readCapped(res, maxBytes, what) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel();
    throw new RelayError(502, `${what}: body too large`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw new RelayError(502, `${what}: body too large`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

/**
 * The fetch a `produce` feed gets: GET only, on the feed's own origin and
 * protocol, only paths in its `upstreamPaths`, no query, no redirects, a size
 * cap, and the request's timeout signal. Resolves to the body.
 */
export function pinnedFetcher(feed, signal) {
  const base = new URL(feed.baseUrl);
  return async (pathname, { maxBytes = 16 * 1024 * 1024 } = {}) => {
    const u = new URL(pathname, base);
    if (
      u.origin !== base.origin ||
      u.search ||
      !matchAllow(feed.upstreamPaths ?? [], u.pathname)
    ) {
      throw new RelayError(502, `${feed.id}: upstream path not pinned`);
    }
    const r = await fetch(u, {
      headers: { ...feed.headers },
      signal,
      redirect: 'manual',
    });
    if (r.status !== 200) {
      await r.body?.cancel();
      throw new RelayError(502, `${feed.id}: upstream answered ${r.status}`);
    }
    return readCapped(r, maxBytes, feed.id);
  };
}

const seconds = (ms) => `${Math.round(ms / 100) / 10} s`;

/**
 * Handle a /feed/<id>/... request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ feeds: import('../feeds.js').Feed[], config: object, env?: NodeJS.ProcessEnv,
 *   cache?: ReturnType<import('./cache.js').createResponseCache>,
 *   health?: Map<string, number> }} ctx  health: base URL -> cooling-down-until (ms)
 */
export async function handleRelay(
  req,
  res,
  {
    feeds,
    config,
    tokenManagers = {},
    governor = null,
    cache = null,
    env = process.env,
    health = null,
  },
) {
  const cors = corsHeaders(req, config.cors);
  try {
    const url = new URL(req.url, 'http://proxy.local');
    const match = url.pathname.match(/^\/feed\/([^/]+)(\/.*)?$/);
    if (!match) throw new RelayError(404, 'unknown route');

    let feedId;
    try {
      feedId = decodeURIComponent(match[1]);
    } catch {
      throw new RelayError(400, 'malformed feed id');
    }
    const rawSubpath = match[2] || '/';
    const feed = feeds.find((f) => f.id === feedId && f.enabled !== false);
    if (!feed) throw new RelayError(404, `unknown feed: ${feedId}`);

    const methods = feed.methods || ['GET'];
    if (!methods.includes(req.method)) {
      throw new RelayError(405, `method ${req.method} not allowed for ${feedId}`);
    }

    const subpath = applyPathPrefix(feed, rawSubpath, env);

    // An operator may point a feed at another instance of the same API (e.g. a
    // self-hosted Overpass) through an env var; the path allowlist still applies.
    const base = resolveBaseUrl(feed, env);
    if (!base.ok) throw new RelayError(502, base.reason);
    const upstreamFeed = base.overridden ? { ...feed, baseUrl: base.baseUrl } : feed;

    const target = buildUpstreamUrl(upstreamFeed, subpath, url.search);
    const judged = base.overridden
      ? allowlistPath(feed, base.baseUrl, target.pathname)
      : target.pathname;
    if (feed.allowPaths && !matchAllow(feed.allowPaths, judged)) {
      throw new RelayError(403, 'path not in feed allowlist');
    }
    // Some generic endpoints pick the operation from the query (OGC services);
    // such a feed pins the query too.
    if (feed.allowQuery && !feed.allowQuery(target.searchParams)) {
      throw new RelayError(403, 'query not allowed for this feed');
    }

    const accept = req.headers['accept'] || '';

    // Response cache (job 6): a fresh hit costs the upstream nothing, so it is
    // answered before the governor counts anything. The key is taken before
    // query or header secrets are injected (cached feeds carry no path-prefix
    // secret) and includes the Accept header, which some APIs (LL2, TfL) use to
    // choose the format: one client asking for HTML must not change what the
    // next client asking for JSON receives. A mirror that served the answer
    // does not change the key: it is the same API.
    const cacheCfg = cache && feed.cache && req.method === 'GET' ? feed.cache : null;
    const cacheKey = cacheCfg ? `${feed.id} ${accept} ${target.href}` : null;
    const fromCache = (maxAgeMs, label) => {
      const hit = cacheKey ? cache.get(cacheKey, maxAgeMs) : null;
      if (!hit) return false;
      const age = Math.round(hit.ageMs / 1000);
      res.writeHead(hit.status, {
        ...cors,
        ...hit.headers,
        'content-length': hit.body.length,
        'x-argus-cache': label,
        // The last good answer standing in for a failed upstream: the client
        // marks the layer STALE (with this age) instead of failing it.
        ...(label === 'stale' ? { 'x-argus-stale': String(age) } : {}),
        age,
      });
      res.end(hit.body);
      return true;
    };
    if (cacheCfg && fromCache(cacheCfg.ttlMs, 'hit')) return;
    const staleMs = cacheCfg ? Math.max(cacheCfg.ttlMs, cacheCfg.staleMs ?? 0) : 0;

    const headers = {};
    if (accept) headers['accept'] = accept;
    injectSecrets(feed, target, headers, env);
    // Static per-feed headers (e.g. a User-Agent some APIs require, like Nominatim).
    if (feed.headers) Object.assign(headers, feed.headers);
    // A feed behind a load balancer with a bad member (CHP) asks for a new
    // connection each time, so a retry can land on another server.
    if (feed.freshConnection) headers['connection'] = 'close';

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await readBody(req);
    }

    // OAuth2 feeds: resolve a Bearer token server side (job 2). The manager
    // caches and refreshes; a missing manager means the feed's credentials were
    // never configured.
    let manager = null;
    if (feed.auth?.type === 'oauth2') {
      manager = tokenManagers[feed.id];
      if (!manager) {
        throw new RelayError(502, `feed ${feed.id} not configured: missing credentials`);
      }
    }

    const timeoutMs = feed.timeoutMs ?? config.timeoutMs;

    // One upstream request (with its own timeout) to one base.
    const runOnce = async (attemptTarget, bearer) => {
      const outbound = bearer
        ? { ...headers, authorization: `Bearer ${bearer}` }
        : headers;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Redirects are followed by hand, so each hop can be checked: equipment
        // you own (localOnly) never redirects, no hop downgrades https to http,
        // and a public feed is never bounced onto this machine or the LAN.
        let hopUrl = attemptTarget;
        let method = req.method;
        let sendBody = body && body.length ? body : undefined;
        let hopHeaders = outbound;
        for (let hop = 0; ; hop += 1) {
          const up = await fetch(hopUrl, {
            method,
            headers: hopHeaders,
            body: sendBody,
            signal: controller.signal,
            redirect: 'manual',
          });
          const location = REDIRECTS.has(up.status) ? up.headers.get('location') : null;
          if (!location) {
            // Read the body inside the same timeout window: a stalled body must
            // abort too, not only a slow connection or headers.
            const b = Buffer.from(await up.arrayBuffer());
            return { up, b };
          }
          await up.body?.cancel();
          const next = new URL(location, hopUrl);
          if (feed.localOnly || hop >= MAX_REDIRECTS) throw new Error('redirect refused');
          if (
            next.protocol !== 'https:' &&
            !(next.protocol === 'http:' && hopUrl.protocol === 'http:')
          )
            throw new Error('redirect downgrade refused');
          if (isPrivateHost(next.hostname) && !isPrivateHost(attemptTarget.hostname))
            throw new Error('redirect to a private host refused');
          if (up.status === 303) {
            method = 'GET';
            sendBody = undefined;
          }
          // Credentials never follow a redirect to another origin (the
          // Bearer token, an injected key header), as fetch's own follow mode
          // also drops them.
          if (next.origin !== hopUrl.origin)
            hopHeaders = withoutSecrets(hopHeaders, feed);
          hopUrl = next;
        }
      } finally {
        clearTimeout(timer);
      }
    };

    // Every base this request may use (one, unless the feed has mirrors), each
    // tried 1 + retries times. The first carries the injected query secrets;
    // a feed with mirrors has none (validateFeeds).
    const bases = orderByHealth(upstreamBases(feed, base), health);
    const attempts = [];
    for (const b of bases) {
      const t =
        b === base.baseUrl
          ? target
          : buildUpstreamUrl({ ...feed, baseUrl: b }, subpath, url.search);
      if (
        feed.allowPaths &&
        !matchAllow(feed.allowPaths, allowlistPath(feed, b, t.pathname))
      )
        continue;
      for (let i = 0; i <= (feed.retries ?? 0); i += 1)
        attempts.push({ base: b, target: t });
    }

    // Try each attempt until one answers. 429, 5xx, a network error or a
    // timeout moves on (and cools that base down); a 200 the feed's validate()
    // rejects moves on too. Resolves to the first good answer, else the last
    // answer marked failed; rejects only when nothing answered at all.
    const runAll = async (bearer) => {
      if (feed.produce) return runProduce(feed, timeoutMs);
      let last = null;
      let lastErr = null;
      for (const a of attempts) {
        let r;
        try {
          r = await runOnce(a.target, bearer);
        } catch (err) {
          lastErr = err;
          health?.set(a.base, Date.now() + MIRROR_COOLDOWN_MS);
          continue;
        }
        const s = r.up.status;
        if (s === 429 || s >= 500) {
          health?.set(a.base, Date.now() + MIRROR_COOLDOWN_MS);
          last = { ...r, failed: true, base: a.base };
          continue;
        }
        if (s === 200 && feed.validate && !feed.validate(r.b, r.up.headers)) {
          last = { ...r, failed: true, base: a.base };
          continue;
        }
        health?.delete(a.base);
        return { ...r, base: a.base };
      }
      if (last) return last;
      throw lastErr ?? new Error('no upstream');
    };

    let bearer = null;
    if (manager) {
      try {
        bearer = await manager.getToken();
      } catch (err) {
        throw new RelayError(502, `auth failed for ${feed.id}: ${err.message}`);
      }
    }

    // Rate / budget governor (job 6): refuse before spending on a metered feed.
    // acquire() counts the request at once (however many mirrors it then
    // tries), so concurrent requests cannot all pass before any is recorded; a
    // request the upstream never answered is refunded below.
    const gov = governor?.acquire(feed.id, target.pathname);
    if (gov && !gov.ok) {
      if (fromCache(staleMs, 'stale')) return;
      throw new RelayError(gov.status, gov.message);
    }
    const refund = () => gov?.ok && governor.refund(feed.id, gov);

    let result;
    try {
      result = await runAll(bearer);
    } catch (err) {
      refund();
      if (fromCache(staleMs, 'stale')) return;
      if (err instanceof RelayError) throw err;
      const timedOut = err?.name === 'AbortError' || err?.name === 'TimeoutError';
      throw new RelayError(
        502,
        timedOut
          ? `upstream timed out after ${seconds(timeoutMs)}`
          : `upstream fetch failed: ${err?.cause?.code || err?.name || 'error'}`,
      );
    }

    // One retry with a fresh token if the upstream rejects the current one.
    if (result.up.status === 401 && manager) {
      manager.invalidate();
      try {
        bearer = await manager.getToken();
        result = await runAll(bearer);
      } catch (err) {
        refund();
        throw new RelayError(
          502,
          `re-auth failed for ${feed.id}: ${err.name || err.message}`,
        );
      }
    }

    // A request the upstream failed to serve does not count against the budget.
    if (result.up.status >= 500) refund();

    const upstream = result.up;
    const buf = result.b;
    if (cacheCfg && result.failed) {
      if (fromCache(staleMs, 'stale')) return;
    }
    const kept = { ...SAFE_HEADERS };
    const ct = upstream.headers.get('content-type');
    if (ct) kept['content-type'] = ct;
    // An image feed serves images only: an HTML or script body on the app's
    // own origin would be a way in.
    if (feed.imageOnly && upstream.status === 200 && !/^image\//i.test(ct || '')) {
      throw new RelayError(502, `feed ${feed.id} answered with a non-image body`);
    }
    const cc = upstream.headers.get('cache-control');
    if (cc) kept['cache-control'] = cc;
    // Only a real answer is kept: never one the feed's validate() rejected.
    if (cacheCfg && upstream.status === 200 && !result.failed) {
      cache.set(
        cacheKey,
        { status: 200, headers: kept, body: buf },
        {
          group: feed.id,
          groupMax: cacheCfg.maxEntries ?? 24,
          groupMaxBytes: cacheCfg.maxBytes,
        },
      );
    }

    res.writeHead(upstream.status, {
      ...cors,
      ...kept,
      'content-length': buf.length,
      ...(cacheCfg ? { 'x-argus-cache': 'miss' } : {}),
      // Which instance answered, when it was not the first choice (a mirror).
      ...(result.base && result.base !== base.baseUrl
        ? { 'x-argus-upstream': new URL(result.base).hostname }
        : {}),
      // A 200 the feed's check rejected (e.g. a truncated document), passed on
      // uncached because nothing better was available.
      ...(result.failed && upstream.status === 200 ? { 'x-argus-invalid': '1' } : {}),
    });
    res.end(buf);
  } catch (err) {
    // Guard against a throw after the upstream response was already written.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = err instanceof RelayError ? err.status : 500;
    sendJson(res, status, { error: err.message || 'relay error' }, cors);
  }
}

/**
 * Run a `produce` feed: it builds its body from pinned upstream files (see
 * pinnedFetcher) within the feed's timeout. Shaped like an upstream answer so
 * caching, staleness and headers work the same.
 */
async function runProduce(feed, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const out = await feed.produce({
      fetch: pinnedFetcher(feed, controller.signal),
      signal: controller.signal,
    });
    return {
      up: {
        status: 200,
        headers: new Headers({ 'content-type': out.contentType || 'application/json' }),
      },
      b: Buffer.isBuffer(out.body) ? out.body : Buffer.from(String(out.body)),
    };
  } finally {
    clearTimeout(timer);
  }
}
