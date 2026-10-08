# proxy

The backbone service. Every real feed routes through it, so no API secret ever
reaches a client, and the phone (which hard-blocks HTTP feeds and gets no CORS
override) reaches everything over one HTTPS origin.

## The six jobs

1. **Key / secret broker**: secrets are read from the environment (or a `.env`
   file) by name and injected into the upstream request server side.
2. **OAuth2 token manager**: OpenSky client credentials, cached and refreshed
   ahead of expiry (`lib/oauth.js`).
3. **CORS shim**: adds the headers feeds omit (`lib/cors.js`).
4. **HTTPS terminator**: `--https` serves TLS with your cert (`PROXY_TLS_KEY` /
   `PROXY_TLS_CERT`) or a self-signed one generated once and kept in
   `~/.config/argus/tls` (it names localhost and this machine's LAN addresses).
5. **Stateful websockets**: one upstream AISStream connection fanned out per
   client viewport (`/ws/ais`), plus the sampled RIPE RIS Live BGP firehose
   (`/ws/bgp`) and a Certificate Transparency stream (`/ws/ct`). All three share
   one HTTP server through a single upgrade router (`lib/wsRoutes.js`).
6. **Rate / budget governor** in front of every metered API (`lib/governor.js`).

It can also serve the built web app from the same origin (`--static dist`, which
is what `npm start` does), so the phone needs only one address.

## Feeds

`feeds.js` is the allowlist of reachable upstreams. A client addresses a feed by
`id` plus a sub-path, never a host, and the sub-path must match the feed's path
allowlist, so there is no open-proxy / SSRF surface. Adding a feed is config:
base URL, methods, path allowlist, secret-injection rules, optional governor.

Current feeds: `opensky`, `adsblol` (keyless flights fallback), `usgs-quakes`,
`celestrak`, `firms`, `overpass`, `shodan`, `nominatim`, `basemap` (Natural Earth
coastlines for the terminal shell), `ripestat`.

## Run

From the repo root (one `npm install` there covers the proxy):

```bash
npm run proxy                    # http on :8787
node proxy/server.js --https     # https on :8787
argus proxy --port 9000 --host 127.0.0.1
argus web                        # proxy + the built app on one origin
```

Or standalone from this folder: `npm install && npm start` (`npm run start:https`).

Other processes can embed it: `startProxy()` in `lib/start.js` (the terminal
shell runs one on 127.0.0.1 with an ephemeral port).

## Endpoints

- `GET /health`: `{ status, service: 'argus-proxy', feeds: [{ id, configured, budget }], streams }`
- `* /feed/<id>/<subpath>`: relayed to the feed's upstream (403 if the path is not allowlisted)
- `GET /tiles/google/...`: Google Photorealistic 3D Tiles, key injected server side
- `WS /ws/ais`, `/ws/bgp`, `/ws/ct`: push feeds
- `OPTIONS *`: CORS preflight
- anything else: the built app when `--static` is set, else 404

## Environment

| Var                                | Default        | Purpose                                       |
| ---------------------------------- | -------------- | --------------------------------------------- |
| `PROXY_PORT`                       | `8787`         | listen port (`0` = ephemeral)                 |
| `PROXY_HOST`                       | all interfaces | bind address; `127.0.0.1` keeps it local-only |
| `PROXY_HTTPS`                      | `false`        | enable TLS (or pass `--https`)                |
| `PROXY_TLS_KEY` / `PROXY_TLS_CERT` | (generated)    | real cert paths, e.g. from mkcert             |
| `PROXY_STATIC_DIR`                 | none           | serve a built web app from this directory     |
| `PROXY_ALLOWED_ORIGINS`            | `*`            | comma list to pin CORS origins                |
| `PROXY_UPSTREAM_TIMEOUT_MS`        | `15000`        | upstream fetch timeout                        |
| `CT_STREAM_URL`                    | CertStream     | CertStream-compatible websocket for `/ws/ct`  |
| `ARGUS_ENV_FILE`                   | none           | an extra `.env` file to load first            |

Feed secrets (`OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `FIRMS_MAP_KEY`,
`AISSTREAM_API_KEY`, `SHODAN_API_KEY`, `GOOGLE_MAPS_API_KEY`) are read from the
environment, then `.env` files: `<repo>/.env`, `proxy/.env`,
`~/.config/argus/.env`. Real environment variables always win.

## Tests

```bash
npm run test:proxy               # from the repo root
```

## Guardrail

Reads already-public indexes only. It never scans, crafts packets, or sends
traffic at a target. See the root `CLAUDE.md` guardrails.
