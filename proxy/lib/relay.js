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
 * @param {{ feeds: import('../feeds.js').Feed[], config: object, env?: NodeJS.ProcessEnv }} ctx
 */
export async function handleRelay(
  req,
  res,
  { feeds, config, tokenManagers = {}, governor = null, env = process.env },
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

    const target = buildUpstreamUrl(feed, subpath, url.search);
    if (feed.allowPaths && !matchAllow(feed.allowPaths, target.pathname)) {
      throw new RelayError(403, 'path not in feed allowlist');
    }

    // Rate / budget governor (job 6): refuse before spending on a metered feed.
    const gov = governor?.check(feed.id, target.pathname);
    if (gov && !gov.ok) throw new RelayError(gov.status, gov.message);

    const headers = {};
    if (req.headers['accept']) headers['accept'] = req.headers['accept'];
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
          redirect: 'follow',
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

    let result;
    try {
      result = await runUpstream(bearer);
    } catch (err) {
      throw new RelayError(502, `upstream fetch failed: ${err.name || 'error'}`);
    }

    // One retry with a fresh token if the upstream rejects the current one.
    if (result.up.status === 401 && manager) {
      manager.invalidate();
      try {
        bearer = await manager.getToken();
        result = await runUpstream(bearer);
      } catch (err) {
        throw new RelayError(
          502,
          `re-auth failed for ${feed.id}: ${err.name || err.message}`,
        );
      }
    }

    // Charge the governor only for a request that actually reached upstream OK.
    if (gov?.ok && result.up.status < 500) governor?.record(feed.id, gov.cost);

    const upstream = result.up;
    const buf = result.b;
    const outHeaders = { ...cors, 'content-length': buf.length };
    const ct = upstream.headers.get('content-type');
    if (ct) outHeaders['content-type'] = ct;
    const cc = upstream.headers.get('cache-control');
    if (cc) outHeaders['cache-control'] = cc;

    res.writeHead(upstream.status, outHeaders);
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
