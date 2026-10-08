// The relay: proxy jobs 1 (key broker) and 3 (CORS) for a single upstream feed.
//
// Flow: /feed/<id>/<subpath> -> look up <id> in the registry -> validate method
// and path -> inject server-side secrets -> fetch the upstream -> return the
// body with CORS headers. The client cannot choose the host (only the feed id),
// and the sub-path cannot escape the feed's configured base path, so there is no
// open-proxy / SSRF surface.

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

/**
 * Handle a /feed/<id>/... request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ feeds: import('../feeds.js').Feed[], config: object, env?: NodeJS.ProcessEnv,
 *   cache?: ReturnType<import('./cache.js').createResponseCache> }} ctx
 */
export async function handleRelay(
  req,
  res,
  { feeds, config, tokenManagers = {}, governor = null, cache = null, env = process.env },
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
    // next client asking for JSON receives.
    const cacheCfg = cache && feed.cache && req.method === 'GET' ? feed.cache : null;
    const cacheKey = cacheCfg ? `${feed.id} ${accept} ${target.href}` : null;
    const fromCache = (maxAgeMs, label) => {
      const hit = cacheKey ? cache.get(cacheKey, maxAgeMs) : null;
      if (!hit) return false;
      res.writeHead(hit.status, {
        ...cors,
        ...hit.headers,
        'content-length': hit.body.length,
        'x-argus-cache': label,
        age: Math.round(hit.ageMs / 1000),
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

    const runUpstream = async (bearer) => {
      const outbound = bearer
        ? { ...headers, authorization: `Bearer ${bearer}` }
        : headers;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const up = await fetch(target, {
          method: req.method,
          headers: outbound,
          body: body && body.length ? body : undefined,
          signal: controller.signal,
          // Equipment you own must not bounce the proxy to some other host.
          redirect: feed.localOnly ? 'error' : 'follow',
        });
        // Read the body inside the same timeout window: a stalled body must
        // abort too, not only a slow connection or headers.
        const b = Buffer.from(await up.arrayBuffer());
        return { up, b };
      } finally {
        clearTimeout(timer);
      }
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
    // acquire() counts the request at once, so concurrent requests cannot all
    // pass before any is recorded; a request the upstream never answered is
    // refunded below.
    const gov = governor?.acquire(feed.id, target.pathname);
    if (gov && !gov.ok) {
      if (fromCache(staleMs, 'stale')) return;
      throw new RelayError(gov.status, gov.message);
    }
    const refund = () => gov?.ok && governor.refund(feed.id, gov);

    let result;
    try {
      result = await runUpstream(bearer);
    } catch (err) {
      refund();
      if (fromCache(staleMs, 'stale')) return;
      throw new RelayError(502, `upstream fetch failed: ${err.name || 'error'}`);
    }

    // One retry with a fresh token if the upstream rejects the current one.
    if (result.up.status === 401 && manager) {
      manager.invalidate();
      try {
        bearer = await manager.getToken();
        result = await runUpstream(bearer);
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
    if (cacheCfg && (upstream.status === 429 || upstream.status >= 500)) {
      if (fromCache(staleMs, 'stale')) return;
    }
    const kept = {};
    const ct = upstream.headers.get('content-type');
    if (ct) kept['content-type'] = ct;
    const cc = upstream.headers.get('cache-control');
    if (cc) kept['cache-control'] = cc;
    if (cacheCfg && upstream.status === 200) {
      cache.set(
        cacheKey,
        { status: 200, headers: kept, body: buf },
        { group: feed.id, groupMax: cacheCfg.maxEntries ?? 24 },
      );
    }

    res.writeHead(upstream.status, {
      ...cors,
      ...kept,
      'content-length': buf.length,
      ...(cacheCfg ? { 'x-argus-cache': 'miss' } : {}),
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
