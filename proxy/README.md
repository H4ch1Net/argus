# proxy

The backbone service. **Phase 2 (v1): key/secret broker + CORS shim + HTTPS terminator.**

Every real feed routes through this one service so that no API secret ever
reaches the browser, and so mobile (which hard-blocks HTTP feeds and gets no CORS
override) can reach HTTP / bare-IP / LAN endpoints over HTTPS.

## What v1 does

- **Key / secret broker** - secrets are read from the environment by name and
  injected into the upstream request server side. They never reach the client.
- **CORS shim** - adds the CORS headers feeds omit so the browser can read them.
- **HTTPS terminator** - serves the browser over HTTPS. Pass real cert paths in
  production; a self-signed cert is generated on demand for local phone testing.
- **Allowlisted relay** - the browser addresses a feed by `id`, never a host, and
  a sub-path cannot escape the feed's base path. No open-proxy / SSRF surface.

Later phases add the OAuth2 token manager (Phase 3), the AIS websocket consumer
(Phase 10), and the rate/budget governor (Phase 13). Not built yet.

## Feeds

`feeds.js` is the allowlist of reachable upstreams. **It is empty in Phase 2**;
real feeds arrive with the phases that use them. The `Feed` shape (base URL,
allowed methods, path allowlist, secret-injection rules) is documented there, so
adding one is config, not code.

## Run

```bash
npm install          # installs selfsigned (only needed for --https)
npm start            # http  on :8787
npm run start:https  # https on :8787 (self-signed unless PROXY_TLS_* is set)
npm test             # node --test (relay, cors, config)
```

## Endpoints

- `GET /health` -> `{ status, phase, feeds: [...ids] }`
- `* /feed/<id>/<subpath>` -> relayed to the feed's upstream (404 until feeds exist)
- `OPTIONS *` -> CORS preflight

## Environment

| Var                                | Default       | Purpose                        |
| ---------------------------------- | ------------- | ------------------------------ |
| `PROXY_PORT`                       | `8787`        | listen port                    |
| `PROXY_HTTPS`                      | `false`       | enable TLS (or pass `--https`) |
| `PROXY_TLS_KEY` / `PROXY_TLS_CERT` | (self-signed) | real cert paths for production |
| `PROXY_ALLOWED_ORIGINS`            | `*`           | comma list to pin CORS origins |
| `PROXY_UPSTREAM_TIMEOUT_MS`        | `15000`       | upstream fetch timeout         |

Feed secrets (e.g. `OPENSKY_TOKEN`) are set here too, server side only, and
referenced by name from `feeds.js`.

## Guardrail

Reads already-public indexes only. It never scans, crafts packets, or sends
traffic at a target. See the root `CLAUDE.md` guardrails.
