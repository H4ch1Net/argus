# Argus

A live 3D globe (CesiumJS) of public data feeds: aircraft, ships, satellites,
earthquakes, fires, surveillance-infrastructure locations, and the internet's own
telemetry (BGP routing, certificate transparency, passive asset lookups). A
personal cybersecurity research tool that runs on a phone (Samsung S25 Ultra
first), on Linux (Kali) and Windows in the browser, and as a dedicated terminal
app.

Based on [`bilawalsidhu/gods-eye-view`](https://github.com/bilawalsidhu/gods-eye-view)
(MIT, code only; data feeds keep their own terms). On top of the reference
globe it adds a phone-first shell, a key-brokering proxy, a passive OSINT
console, internet-infrastructure layers, a time scrubber, and a terminal
version, all from one shared data engine. Voice control and anything that
identifies or acts on people or hosts are deliberately left out (see
[Guardrails](#guardrails)).

## Run it

| Where                             | Command                                  | What you get                                                                            |
| --------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| PC or Kali, in a browser          | `npm start`                              | Builds once, then serves the globe and its proxy at `http://localhost:8787`             |
| Phone on the same Wi-Fi           | `npm run start:https`                    | Open the printed `https://<LAN-IP>:8787` on the phone and accept the certificate once   |
| Android phone, no PC (Termux)     | `bash scripts/install-termux.sh`         | Proxy, globe and terminal version all on the phone; open `http://localhost:8787`        |
| Any terminal (Kali, SSH, Windows) | `npm run tui`                            | Full-screen braille world map with the same layers, cards, and commands; no GPU needed  |
| Scripts and pipes                 | `argus query 8.8.8.8 --json`             | Passive lookups, quakes, flights, satellites, fires, BGP and CT streams as text or JSON |
| No network at all                 | `npm run dev` or `npm run tui -- --demo` | Every layer on simulated data, clearly labelled DEMO                                    |

First run:

```bash
git clone https://github.com/H4ch1Net/argus.git
cd argus
npm install
npm start
```

On Kali, `./scripts/install-linux.sh` does the install and adds an `argus`
command, a private keys file, menu launchers for both the globe and the
terminal version, and a GPU check. On Android, `scripts/install-termux.sh` does the same
inside Termux (see SETUP.md, Android standalone). Full instructions, the phone setup, and
troubleshooting are in **[SETUP.md](SETUP.md)**.

**Keys are optional.** With none, you get flights (via adsb.lol), earthquakes,
satellites, OSM landmarks and surveillance-camera locations, place search, BGP
activity, and the RIPEstat OSINT console. Free keys add OpenSky flights, NASA
FIRMS fires, and AIS ships. Keys live in `.env` or `~/.config/argus/.env` and are
read only by the proxy, never by the browser.

## Layers and features

| Layer / feature         | Source                                              | Key             | Notes                                                                         |
| ----------------------- | --------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| Flights                 | OpenSky, or adsb.lol when OpenSky is not configured | optional (free) | Viewport-bounded, interpolated between fixes, click to track, cockpit mode    |
| Earthquakes             | USGS                                                | none            | Sized and coloured by magnitude                                               |
| Satellites              | CelesTrak TLE + SGP4                                | none            | Positions computed locally, orbit rings                                       |
| Fires                   | NASA FIRMS VIIRS                                    | free MAP_KEY    | Viewport-bounded                                                              |
| Ships                   | AISStream via the proxy websocket                   | free key        | The proxy holds one upstream socket and fans out per viewport                 |
| Surveillance, landmarks | OpenStreetMap Overpass                              | none            | Camera and ALPR reader LOCATIONS only; loads once zoomed to a city            |
| Shodan density          | Shodan facet counts                                 | Shodan key      | Credit-free snapshot, budget governor in the proxy                            |
| BGP activity            | RIPE RIS Live via the proxy websocket               | none            | Pulses at the route collector that saw each update                            |
| CT firehose             | CertStream-compatible aggregator                    | none            | Issuance ticker; set `CT_STREAM_URL` if the public server is silent           |
| OSINT console           | RIPEstat (+ Shodan host data when keyed)            | none            | `query` / `correlate` an IP, domain, or ASN: routing, registry, geo, exposure |
| CCTV, threat arcs       | none verified                                       | n/a             | Simulated, labelled DEMO in the UI                                            |
| Globe                   | Esri imagery + elevation, OSM streets               | none            | Google Photorealistic 3D Tiles optional (`GOOGLE_MAPS_API_KEY`)               |

Cross-cutting: presets (Around Me, Sky, Disaster, Environment, Surveillance),
global search and fly-to, click or tap to track with trails and metadata cards,
an in-app command terminal, NVG/FLIR/CRT sensor shaders, a time scrubber over the
in-memory history, and mobile-only point-at-sky (compass) mode.

The phone build is reduced by design: explicit resolution scale, 30 fps ambient
cap, on-demand rendering, WebGL context-loss recovery, capped tile caches, and a
thermal ladder that gives up post-processing, then resolution, then terrain when
the frame-time trend shows the device heating up. It installs as an app (PWA)
when served over trusted HTTPS.

## The terminal version

`argus tui` draws the world as Unicode braille (or ASCII with `--ascii`) with
coastlines, a graticule, place names, and every live layer as coloured glyphs.
It embeds a loopback-only proxy, so it reads the same `.env` and needs nothing
else running.

```
 ◉ ARGUS  GLOBAL SIGNALS TERMINAL                             DEMO DATA  2,657 km across  23:44:08Z
   ⡁         130W      125W      120W      115W      110W    │ LAYERS
   ⠄         ⠄         ⠄ ⢸       ⠠         ⠠         ⠠       │ 1 ● Flights       40
45N⠂⠁ ⠁ ⠁ ⠁ ⠁⠂⠁ ⠁ ⠁ ⠁ ⠁⠂⠁⢸⠁ ⠁ ⠁ ⠁⠐⠁ ⠁ ⠁ ⠁ ⠁⠐⠁ ⠁ ⠁ ⠁ ⠁⠐⠁ ⠁ ⠁ ⠁│ 2 ● Earthquakes   8
   ⡁         ⡁         ⡁ ⡎       ⢈         ⢈         ⢈       │ 3 ○ Satellites
   ⠄         ⠄         ⠄⢰⠁       ⠠         ⠠         ⠠       │ 4 ○ Fires
   ⠂ ◈       ⠂         ⠂⠸⡀       ⠐         ⠐         ⠐       │ 5 ○ Ships
   ⡁         ⡁         ⡁ ⡇       ⢈         ⢈         ⢈       │ 6 ● Surveillance  30
   ⠄         ⠄         ⠄⢰⠁       ⠠         ⠠         ⠠       │ 7 ○ Landmarks
40N⠂⠂ ⠂ ⠂ ⠂ ⠂⠂⠂ ⠂ ⠂ ⠂ ⠂⠂⠚⡄⠂ ⠂ ⠂ ⠂⠐⠂ ⠂ ⠂ ⠂ ⠂⠐⠂ ⠂ ⠂ ⠂ ⠂⠐⠂ ⠂ ⠂ ⠂│ 8 ○ Shodan
   ⡁         ⡁         ⡁ ⠘⡄O     ⢈         ⢈         ⢈       │ 9 ○ BGP
   ⠄         ⠄         ⠄  ⠘⡄     ⠠         ⠠         ⠠       │
   ⠂         ⠂         ⠂   ⠈∙San Francisco ⠐         ⠐       │ LEGEND
```

(A real frame from `argus tui --demo`, cropped to the top rows; in a terminal it is in colour.)

Keys: arrows or `hjkl` pan, `+`/`-` or the mouse wheel zoom, `1`-`9` toggle
layers, `Tab` cycles through what is in view, `Enter` tracks it, `:` opens the
command line (`goto`, `track`, `query`, `correlate`, `layer`, `preset`, `find`,
`export`, `status`), `c` the CT ticker, `?` help, `q` quit. Set `ARGUS_HOME=lat,lon`
(or `--at`) for "Around Me", since a terminal has no GPS.

## Architecture

```
core/            shared engine: Layer SDK, data integrations, proxy client, Cesium
                 scene, interpolation, SGP4, presets, search, OSINT console
shell-mobile/    phone: bottom sheet, touch + S Pen, Around Me, compass, PWA
shell-desktop/   Linux / Windows browser: side panel, mouse + keyboard
shell-terminal/  terminal: braille map, keyboard + mouse, scriptable CLI
proxy/           the backbone: key broker, OAuth2, CORS, HTTPS, websockets,
                 budget governor, and (for npm start) the built app
bin/argus.js     one launcher: web, proxy, tui, and the CLI commands
```

All three shells consume the same core parsers, normalizers, card formatters,
push clients, presets, and command language. Every real request goes through the
proxy's allowlist, so no secret ever reaches a client.

## Guardrails

Argus visualizes data that is already public. It never generates new
surveillance of people and never acts against a target:

- Surveillance layers map where cameras and ALPR readers are, never what they see.
- OSINT inputs are assets (IP, domain, ASN), never people. Anything else is refused.
- Lookups read published indexes (RIPEstat, Shodan's existing scans, CT logs, RIS);
  nothing scans or sends traffic at a host.
- No voice control.

See `CLAUDE.md` for the full rules.

## Develop

```bash
npm run dev          # Vite dev server; add `npm run proxy` in another terminal for live data
npm run dev:https    # same over HTTPS, for testing on the phone
npm test             # core, mobile shell, and terminal shell tests
npm run test:proxy   # proxy tests
npm run lint
npm run format:check
```

Read `CLAUDE.md` before writing code. Rationale lives in
`docs/gods-eye-view-master-plan.md`; the verified status of every feature is in
`docs/AUDIT.md`.
