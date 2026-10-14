# Argus

Argus is a live 3D globe, built on CesiumJS, that plots public data feeds: aircraft, ships, satellites, earthquakes, fires, storms, surveillance-infrastructure locations, and internet telemetry such as BGP routing and certificate transparency. It is a personal cybersecurity research project. It runs in a browser on a phone, on Linux and on Windows, and as a terminal app that shares the same data engine.

It is based on [`bilawalsidhu/gods-eye-view`](https://github.com/bilawalsidhu/gods-eye-view) (MIT, code only; the data feeds keep their own terms).

Built with CesiumJS, Vite, satellite.js and ws, on Node.js 20.19 or newer, with plain JavaScript and no framework.

Status: Round 7 ran the app on real CesiumJS (headless Chromium with software WebGL) against the real proxy and live feeds. Nothing has run on a phone's GPU or in a car yet. [docs/AUDIT.md](docs/AUDIT.md) records what has been checked and how. Some feeds carried over from the reference project are marked in `proxy/feeds.js` as not yet live-tested.

## What it shows

- Aircraft: flights (OpenSky with a free key, otherwise adsb.lol), military aircraft, and aircraft heard by your own ADS-B receiver.
- Satellites with orbit rings and next-pass predictions, and rocket launches with a replay.
- Ships (AIS, free key), public transit and bikeshare.
- Earthquakes, fire hotspots and perimeters, cyclones with forecast cones and tracks, wind, and weather imagery.
- Public traffic cameras, public webcams, border wait times, traffic flow and incidents.
- Surveillance infrastructure: where cameras and ALPR readers are, traffic lights, data centres, dams, and submarine cables.
- Internet telemetry: BGP activity, certificate transparency issuance, Tor relays, and Shodan exposure snapshots.
- Search (places, addresses and street crossings such as "Highway 111 and Golf Center Pkwy"), saved places, routing and distances, plus an OSINT console that takes an IP, domain or ASN and shows its routing, registry, geography and exposure.

Most of this needs no key. Free keys add OpenSky flights, NASA FIRMS fires, AIS ships and TomTom traffic. A Mapillary token adds street photos. Each key is optional, and the app runs with whichever ones you have.

Argus only reads data that is already public. It does not read licence plates, look up people, or scan or send traffic at a host. Voice control is out of scope.

## How it works

The code is split into a shared core and several shells. `core/` holds the data engine: the layer SDK, feed integrations, the Cesium scene, presets, search and the OSINT console. Each shell is a different front end on top of it: `shell-mobile/` for phones, `shell-desktop/` for Linux and Windows browsers, `shell-terminal/` for the terminal app, and `shell-car/` for the Android Auto navigation screen. Nothing in `core/` assumes a mouse, a keyboard or a desktop GPU.

Every feed goes through the proxy in `proxy/`. The proxy holds the API keys, fetches OpenSky's OAuth2 token, adds the CORS headers that many feeds lack, serves HTTPS so phones accept the connection, keeps the AIS and BGP websocket connections open, and caps calls to metered APIs. Keys are read only by the proxy, from `.env`, `proxy/.env` or `~/.config/argus/.env`. The browser never sees them.

Each layer follows the same pipeline. It fetches data (by polling, by a push stream, once, or by computing it), normalizes each record to an id, a position, a type and metadata, and renders it as a point, billboard, trail, raster or arc. Moving things are interpolated. Fetches are limited to the area in view, so the proxy only asks upstream for what is on screen.

The phone build is deliberately lighter. It caps resolution and frame rate, falls back to less work when the device heats up, recovers when the WebGL context is lost, and installs as an app when served over trusted HTTPS.

Time works the same way for moving things. The display runs about one polling interval behind real time and tweens between the last two fixes, which is what keeps updates that arrive every 15 to 30 seconds looking smooth. Static layers are fetched once per map tile and kept for hours.

## Quick start

Requires Node.js 20.19 or newer.

```bash
git clone https://github.com/H4ch1Net/argus.git
cd argus
npm install
npm start
```

`npm start` builds the app if the sources changed, then serves the globe and the proxy together at `http://localhost:8787`.

Other ways to run it:

- Kali or other Linux: `./scripts/install-linux.sh` installs the dependencies, an `argus` command, a keys file (mode 600), menu launchers for the globe and the terminal version, and checks the GPU and fonts. It needs no root. The interface uses JetBrains Mono (`sudo apt install fonts-jetbrains-mono`), and falls back to a system monospace without it.
- A phone on the same Wi-Fi: `npm run start:https`, then open the printed `https://<LAN-IP>:8787` on the phone and accept the certificate once. Location, compass and install need HTTPS.
- Android app: install `argus-android.apk` from the releases page. It runs the proxy on the phone. Android Auto only shows it when it is installed from Google Play, which a private internal testing track does. See [docs/ANDROID.md](docs/ANDROID.md).
- Android in Termux, with no PC: `bash scripts/install-termux.sh`, then open `http://localhost:8787`.
- Terminal, on Linux, over SSH or on Windows: `npm run tui`. It needs no GPU.
- No network at all: `npm run dev` or `npm run tui -- --demo`. Every layer except the imagery overlays runs on simulated data, labelled DEMO.

Full install notes, phone setup and troubleshooting are in [SETUP.md](SETUP.md).

## Demo

Try the terminal version on simulated data:

```bash
npm run tui -- --demo
```

The `argus` command runs the same engine for one-off lookups:

```bash
argus measure London Paris                             # works offline
argus query 8.8.8.8 --json                             # passive lookup, needs network
argus route "San Francisco" "Los Angeles" --mode car   # turn-by-turn, needs network
argus help                                             # everything else
```

Commands:

- `argus web [--https] [--open]` builds and serves the app and proxy. `argus proxy` runs only the proxy.
- `argus tui [--demo]` opens the terminal version.
- `argus query`, `argus correlate` take an IP, domain or ASN.
- `argus quakes`, `flights`, `military`, `storms`, `launches`, `sats`, `fires`, `geocode`, `flow`, `shodan`, `photo`, `bgp`, `ct` and `health` return live data. Add `--json` for machine-readable output.
- `argus route` and `argus measure` take two places.

In the globe, click or tap a contact to track it. Long-press (or right-click) the map for WHAT'S HERE: save the place, route to or from it, copy or share it. GEO shows and follows your position like a map app (tap again for heading-up). `G` opens WHERE TO, `F` follows the target, `/` opens search, the backtick opens the terminal, and `?` lists every shortcut.

The terminal version draws the world with braille characters, or ASCII with `--ascii`, and shows every live layer as coloured glyphs. Move with the arrow keys or `hjkl`, zoom with `+` and `-`, toggle the first nine layers with `1` to `9`, and press `:` for the command line. A terminal has no GPS, so set `ARGUS_HOME=lat,lon` (or pass `--at`) to set the "Around Me" location.

## Configuration

Copy `.env.example` to `.env` in the repository root, or to `~/.config/argus/.env`, and uncomment what you need. A typical file:

```bash
PROXY_PORT=8787
OPENSKY_CLIENT_ID=your-client-id
OPENSKY_CLIENT_SECRET=your-client-secret
FIRMS_MAP_KEY=your-firms-key
AISSTREAM_API_KEY=your-aisstream-key
TOMTOM_API_KEY=your-tomtom-key
LOCAL_ADSB_URL=http://localhost:8080/data
ARGUS_HOME=37.77,-122.42
```

| Variable                                                              | Purpose                                                                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PROXY_PORT`, `PROXY_HOST`                                            | Port (default 8787) and bind address. Leaving `PROXY_HOST` unset listens on all interfaces, which phones need. |
| `PROXY_HTTPS`, `PROXY_TLS_KEY`, `PROXY_TLS_CERT`                      | HTTPS, with your own certificate if you have one (otherwise a self-signed one)                                 |
| `PROXY_ALLOWED_ORIGINS`                                               | Comma-separated list of origins allowed by CORS (default `*`)                                                  |
| `PROXY_UPSTREAM_TIMEOUT_MS`                                           | Timeout for upstream requests (default 15000)                                                                  |
| `VITE_PROXY_BASE_URL`                                                 | Where the dev server or built app finds the proxy                                                              |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`                          | OpenSky flights                                                                                                |
| `FIRMS_MAP_KEY`                                                       | NASA FIRMS fires                                                                                               |
| `AISSTREAM_API_KEY`                                                   | AIS ships                                                                                                      |
| `TOMTOM_API_KEY`                                                      | Traffic flow, incidents and traffic-aware routing                                                              |
| `GOOGLE_MAPS_API_KEY`                                                 | Google Photorealistic 3D Tiles, which are optional                                                             |
| `SHODAN_API_KEY`                                                      | Shodan host data                                                                                               |
| `MAPILLARY_TOKEN`, `MAPILLARY_IMAGE_URL`                              | Street photos, and the image host if the default one is not right                                              |
| `TFL_APP_KEY`                                                         | Raises the anonymous rate limit for Transport for London feeds                                                 |
| `WINDY_WEBCAMS_KEY`, `NPS_API_KEY`                                    | Public webcams                                                                                                 |
| `WSDOT_ACCESS_CODE`, `UDOT_TRAFFIC_KEY`, `NVROADS_KEY`, `CTROADS_KEY` | Traffic cameras from the 511 networks                                                                          |
| `LOCAL_ADSB_URL`, `LOCAL_UAT_URL`                                     | Your own dump1090 or readsb, and dump978, on your LAN or this machine                                          |
| `LOCAL_WAZE_URL`                                                      | Your own waze-server, instead of the live Waze map                                                             |
| `CT_STREAM_URL`                                                       | A CertStream-compatible stream for the certificate ticker                                                      |
| `OVERPASS_URL`, `CHP_CAD_URL`, `RADIO_BROWSER_URL`                    | Override the public Overpass, California CHP and Radio Browser servers                                         |
| `ARGUS_HOME`                                                          | Home location `lat,lon` for "Around Me" in the terminal                                                        |
| `ARGUS_SHODAN_SNAPSHOT`                                               | Which curated Shodan snapshot the terminal shows                                                               |

Keys can be moved between devices from SETUP > KEYS as a passphrase-encrypted file (scrypt and AES-256-GCM), or imported from a `.env` file.

## Develop

```bash
npm run dev          # Vite dev server; run `npm run proxy` in another terminal for live data
npm run dev:https    # the same over HTTPS, for testing on a phone
npm test             # core, mobile shell, car shell and terminal shell tests
npm run test:proxy   # proxy tests
npm run lint
npm run format:check
```

## Architecture

Read [CLAUDE.md](CLAUDE.md) before writing code. It has the binding rules: the shell boundaries, the Layer SDK contract, and the guardrails. The rationale is in [docs/gods-eye-view-master-plan.md](docs/gods-eye-view-master-plan.md), and [docs/COMPARISON.md](docs/COMPARISON.md) compares the feature set with the reference project.

Contributors: read CLAUDE.md first, and run `npm test`, `npm run test:proxy`, `npm run lint` and `npm run format:check` before you push.

## Guardrails

Argus visualizes data that is already public. It never generates new surveillance of people and never acts against a target.

- Surveillance layers map where cameras and ALPR readers are. They never read what the cameras see. Public traffic-camera stills are shown as published, and nothing analyses them.
- Aircraft owners, plates and other person-level fields are not shown.
- OSINT inputs are assets (IP, domain, ASN), never people. Anything else is refused.
- Lookups read published indexes such as RIPEstat, Shodan's existing scans, CT logs and RIS. Nothing scans a host or sends it traffic.
- Voice control is out of scope.
