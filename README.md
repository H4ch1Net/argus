# Argus

A live 3D globe (CesiumJS) of public data feeds: aircraft, ships, satellites,
earthquakes, fires, storms, surveillance-infrastructure locations, and the
internet's own telemetry (BGP routing, certificate transparency, passive asset
lookups). A personal cybersecurity research tool that runs on a phone (Samsung
S25 Ultra first), on Linux (Kali) and Windows in the browser, and as a dedicated
terminal app.

Based on [`bilawalsidhu/gods-eye-view`](https://github.com/bilawalsidhu/gods-eye-view)
(MIT, code only; data feeds keep their own terms). On top of the reference
globe it adds a phone-first shell, a key-brokering proxy, a passive OSINT
console, internet-infrastructure layers, a time scrubber, and a terminal
version, all from one shared data engine, dressed in a ctOS-style interface.
Voice control and anything that identifies or acts on people or hosts are
deliberately left out (see [Guardrails](#guardrails)).

**Testing status.** The latest round (the ctOS interface, the faster renderer,
and the last of the reference's features) was built with no network access:
nothing ran against real Cesium or a live feed, and every new upstream is
marked "per the reference implementation, not live-tested here". The interface
was checked in a stub-Cesium harness with headless screenshots, and the pure
logic by unit tests. What is verified, and how, is in
**[docs/AUDIT.md](docs/AUDIT.md)**.

## Run it

| Where                             | Command                                  | What you get                                                                                                                   |
| --------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| PC or Kali, in a browser          | `npm start`                              | Builds once, then serves the globe and its proxy at `http://localhost:8787`                                                    |
| Phone on the same Wi-Fi           | `npm run start:https`                    | Open the printed `https://<LAN-IP>:8787` on the phone and accept the certificate once                                          |
| Android phone, no PC (Termux)     | `bash scripts/install-termux.sh`         | Proxy, globe and terminal version all on the phone; open `http://localhost:8787`                                               |
| Any terminal (Kali, SSH, Windows) | `npm run tui`                            | Full-screen braille world map with the same layers, cards, and commands; no GPU needed                                         |
| Scripts and pipes                 | `argus query 8.8.8.8 --json`             | Passive lookups, quakes, flights, military, storms, launches, satellites, fires, routes, distances, BGP and CT as text or JSON |
| No network at all                 | `npm run dev` or `npm run tui -- --demo` | Every layer except the imagery overlays (weather, GOES, recent imagery, traffic flow) on simulated data, clearly labelled DEMO |

First run:

```bash
git clone https://github.com/H4ch1Net/argus.git
cd argus
npm install
npm start
```

On Kali, `./scripts/install-linux.sh` does the install and adds an `argus`
command, a private keys file, menu launchers for both the globe and the
terminal version, a GPU check, and a font check (the interface is set in
JetBrains Mono: `sudo apt install fonts-jetbrains-mono`; without it a system
monospace is used). On Android, `scripts/install-termux.sh` does the same
inside Termux (see SETUP.md, Android standalone). Full instructions, the phone setup, and
troubleshooting are in **[SETUP.md](SETUP.md)**.

**Keys are optional.** With none, you get flights and military aircraft (via
adsb.lol, with a 24 h trace and adsbdb type and route details on request), live
transit and bikeshare, satellites with next-pass predictions, rocket launches
with a reconstructed replay, earthquakes, cyclones with forecast cones and
tracks, fire perimeters, wind, weather imagery with a history timeline, recent NASA
satellite imagery, public traffic cameras in twelve networks, radio stations
with a tuner, OSM camera, data-centre, dam and installation locations,
submarine cables, place search, routing, BGP activity, and the RIPEstat OSINT
console. Free keys add OpenSky flights, NASA FIRMS fires, AIS ships and TomTom
traffic flow; an SDR receiver running dump1090 (1090 MHz) or dump978 (978 MHz
UAT) adds the aircraft your own antenna hears. Keys live in `.env` or
`~/.config/argus/.env` and are read only by the proxy, never by the browser.

## Layers and features

| Layer / feature                   | Source                                                                                                                                      | Key                | Notes                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Flights                           | OpenSky, or adsb.lol when OpenSky is not configured                                                                                         | optional (free)    | Viewport-bounded, interpolated, a silhouette per aircraft class, 3D models up close; TRACE 24H and adsbdb details |
| Military air                      | adsb.lol military list                                                                                                                      | none               | Global; the card names the operating service                                                                      |
| My receiver                       | your dump1090 / readsb and dump978 (`LOCAL_ADSB_URL`, `LOCAL_UAT_URL`)                                                                      | none               | Aircraft your own SDR hears on 1090 MHz and 978 MHz UAT; LAN or this machine only                                 |
| Satellites, Nav, GEO & visual     | CelesTrak TLE + SGP4                                                                                                                        | none               | Stations with orbit rings; GPS, Galileo, GLONASS, GEO, brightest; NEXT PASS; Starlink dense (desktop)             |
| Launches                          | Launch Library 2                                                                                                                            | none               | Pads with launches a week back to six weeks ahead; REPLAY (a reconstructed estimate)                              |
| Transit                           | GTFS-Realtime from 7 operators (Boston to Brisbane)                                                                                         | none               | Default-on; loads when the view is over a covered city                                                            |
| Bikeshare                         | GBFS from 16 systems                                                                                                                        | none               | Stations, dimmed when empty                                                                                       |
| Ships                             | AISStream via the proxy websocket                                                                                                           | free key           | The proxy holds one upstream socket and fans out per viewport                                                     |
| Traffic flow                      | TomTom raster flow tiles                                                                                                                    | free key           | Roads coloured by current speed; the proxy caps tiles at 6,000 a day                                              |
| Earthquakes                       | USGS                                                                                                                                        | none               | Sized by magnitude; red only from M6                                                                              |
| Fires, fire perimeters            | NASA FIRMS VIIRS; NIFC WFIGS (US)                                                                                                           | free MAP_KEY; none | Hotspots viewport-bounded; perimeters filled by containment                                                       |
| Cyclones, storm cones and tracks  | NOAA National Hurricane Center (+ NHC GIS)                                                                                                  | none               | Atlantic and eastern/central Pacific, advisory link, 5-day cone and track                                         |
| Wind                              | Open-Meteo current 10 m wind on a grid over the view                                                                                        | none               | Particle streaks; WIND readout in the desktop strip; at most 120 requests a day                                   |
| IR clouds, GOES, radar, lightning | NOAA nowCOAST imagery                                                                                                                       | none               | Raster overlays; VIEW > WEATHER HISTORY steps back through the last day                                           |
| Recent imagery                    | NASA HLS (CMR + GIBS), VIIRS (GIBS, Worldview Snapshots)                                                                                    | none               | TOOLS > RECENT IMAGERY: pick an area, then a day from the last 30                                                 |
| Surveillance, landmarks           | OpenStreetMap Overpass                                                                                                                      | none               | Camera and ALPR reader LOCATIONS only; loads once zoomed to a city                                                |
| Traffic cams                      | 12 public networks (Caltrans, TfL, Statens vegvesen, Ontario 511, DriveBC, Calgary, Fintraffic, TxDOT, Austin, Tarktee, Tallinn, Warendorf) | none               | Public stills, shown in the card on request; nothing analyses them                                                |
| Data centres, dams, installations | OpenStreetMap Overpass                                                                                                                      | none               | Facility locations as mapped by contributors                                                                      |
| Sea cables                        | TeleGeography submarine cable map                                                                                                           | none               | Drawn on the globe; landing points in the terminal (CC BY-NC-SA 3.0)                                              |
| Radio                             | Radio Browser                                                                                                                               | none               | Located stations; TOOLS > RADIO is an analog tuner over them (https streams only)                                 |
| Shodan density                    | Shodan facet counts                                                                                                                         | Shodan key         | Credit-free snapshot, budget governor in the proxy                                                                |
| BGP activity                      | RIPE RIS Live via the proxy websocket                                                                                                       | none               | Pulses at the route collector that saw each update                                                                |
| CT firehose                       | CertStream-compatible aggregator                                                                                                            | none               | Issuance ticker; set `CT_STREAM_URL` if the public server is silent                                               |
| OSINT console                     | RIPEstat (+ Shodan host data when keyed)                                                                                                    | none               | `query` / `correlate` an IP, domain, or ASN: routing, registry, geo, exposure                                     |
| Search and routes                 | Bundled places (~430), Photon, Nominatim; OSRM (FOSSGIS)                                                                                    | none               | Places answer offline first; TOOLS > ROUTE for car, foot or bike, with FLY ALONG                                  |
| Cockpit briefing (desktop)        | Nominatim, Open-Meteo, Google News RSS, GDELT                                                                                               | none               | Nearest contacts, headlines and weather for the place below, each credited                                        |
| CCTV projection, threat arcs      | none verified                                                                                                                               | n/a                | Simulated, labelled DEMO in the UI                                                                                |
| Globe                             | Esri dark canvas, imagery and elevation, OSM streets, Esri label tiles                                                                      | none               | Google Photorealistic 3D Tiles optional (`GOOGLE_MAPS_API_KEY`)                                                   |

How this compares with the reference project, layer by layer, and what was left
out on purpose: **[docs/COMPARISON.md](docs/COMPARISON.md)**.

## The interface

There are no screenshots of the globe in this repository yet (it has not been
run against real Cesium; see the testing status above), so in words: the
interface follows a ctOS design system. Everything is set in JetBrains Mono
(or a system monospace when it is not installed) with square corners, corner-bracket frames, grays and the Mono Glow teals and
mint; green and red only ever mean a state (live, locked, error, hazard). The
map uses the same palette: a silhouette per aircraft class and a ctOS glyph
per layer (hull, vehicle, satellite node, diamond, bracket, pulse and so on),
on a dark mono basemap. Close up, aircraft become 3D models of their class.

- **Desktop**: a 37px bar across the top (the ARGUS lockup, preset cells NEAR,
  SKY, WATCH, HAZ, ENV, NET, the FPS and OBJ meters, SEARCH, the LIVE / DEMO feed
  state and UTC time), a tabbed menu on the left (LAYERS / VIEW / TOOLS), the
  target panel on the right, the view stack (+ / -, N, TLT, whole Earth, GEO) at
  the right edge, and a bottom strip with POS / ALT / HDG, WIND (while the wind
  layer is on), the timeline and TERM.
- **Phone**: a compact bar, the view stack in thumb reach, and a bottom sheet
  with LAYERS / TARGET / VIEW / TOOLS tabs that snaps between peek, half and full.
- **The tracking overlay** draws Bagley-style tracking boxes with two-digit IDs
  on the contacts nearest the middle of the view (VIEW > TRACKING: OFF, LOW,
  MED, HIGH), dashed mesh edges between them, the selected target as hub 00
  (LOCK in green while following), a viewport frame with corner readouts, and
  offline city names. The boxes come from feed positions, never from imagery.
- **The target panel** opens when you click or tap a contact. The camera stays
  where it is; the panel shows the live tracking widget, the card with source
  links, actions (FOLLOW, FLY TO, COCKPIT, and per layer TRACE 24H, NEXT PASS,
  REPLAY, NEAREST CAM, PROJECT), and CONTACTS: the nearest contacts with the
  same IDs as the map, with PREV / NEXT to step through them. On the phone the
  target glides into view above the sheet. PROJECT on a traffic camera places
  its published still in 3D at the end of its frustum, with a gizmo to adjust
  the pose.
- **VIEW**: basemap (DARK, SAT, STREETS, RELIEF offline) and MONO; LABELS (city
  names offline, places + borders, street names); tracking density and the
  viewport frame; terrain; 3D MODELS (close aircraft as glTF models of their
  class, on by default on the desktop); Starlink dense (desktop); weather history; sensor
  looks (NVG, FLIR, Noir on every tier with shaders; Snow, CRT, sharpen and
  bloom on the desktop); DISPLAY (the Intel HUD with MGRS, GSD and NIIRS, sun
  elevation and off-nadir angle; clean view; orbit); the system readout.
- **TOOLS**: ROUTE, DRAW + MEASURE, RECENT IMAGERY, SHARE (the address bar always
  holds the current view, so a reload or a copied link reopens it), SCENES
  (capture views as shots and play them as a tour; saved on this device or as
  JSON files), LANDMARKS (public landmarks in nine cities), RADIO, the
  console, the Certificate Transparency ticker, and DATA CREDITS (on the phone
  the TIMELINE scrubber lives here too).
- **Presets** give the view back: pressing the active preset again returns the
  camera and layers to what they were before it.
- **Cockpit** (desktop): a briefing strip (nearest contacts, regional news,
  local info) and the observed weather below drawn over the view.
- Notifications slide in top right (mako style), search is a rofi-style
  launcher, the terminal is a kitty-style window, and a short boot splash runs
  while the globe starts.

### Controls

| Input                    | Action                                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| Click / tap a contact    | Select it: target panel, trail, hub lock (the camera stays put)                  |
| `F`                      | FOLLOW the target at the current distance (again to stop)                        |
| `C`                      | COCKPIT: ride along with a moving target (not on minimal tier)                   |
| `Esc`                    | Leave cockpit first; otherwise release the target (and cancel an armed map tool) |
| `/` or `Ctrl+K`          | Search launcher (arrows move, Enter picks, Esc closes)                           |
| `` ` `` (backtick)       | Terminal (Up / Down for history, Esc closes)                                     |
| `M` / `T` (desktop)      | Show or hide the menu / the target panel                                         |
| `1` to `6`               | Presets NEAR, SKY, HAZ, ENV, WATCH, NET (again to leave and get the view back)   |
| `N` / `P`                | Next / previous contact                                                          |
| `H`                      | Intel HUD                                                                        |
| `O`                      | Orbit the middle of the view (any press stops it)                                |
| `D`                      | Tracking box density (off, low, med, high)                                       |
| `V`                      | Clean view: hide the interface (the UI chip brings it back)                      |
| `?`                      | The list of shortcuts                                                            |
| Wheel, pinch, + / -      | Zoom; left-drag rotates; right- or middle-drag, or two fingers, tilt             |
| N, TLT, whole Earth, GEO | North up, straight down or oblique, the whole Earth, your position               |

The phone build is reduced by design: explicit resolution scale, 30 fps ambient
cap, on-demand rendering, WebGL context-loss recovery, capped tile caches, and a
thermal ladder that gives up post-processing, then resolution, then terrain when
the frame-time trend shows the device heating up. It installs as an app (PWA)
when served over trusted HTTPS.

Rendering is built to stay cool: point and billboard layers draw on one Cesium
BillboardCollection per layer (no Entity per contact), movers re-interpolate on
a fleet tick that matches the paced frame rate (15 Hz for fleets of thousands)
and only write a position after it moved more than a metre,
the horizon cull allocates nothing per frame, and one shared frame pacer
requests frames only while something animates (30 fps on the full tier, 20
balanced, 15 minimal, 60 in cockpit). All tracking text is one 2D canvas, not
Cesium labels, and close-range 3D aircraft are capped per tier (60 full, 12
balanced, none minimal).

## The terminal version

`argus tui` draws the world as Unicode braille (or ASCII with `--ascii`) with
coastlines, a graticule, place names, and every live layer as coloured glyphs.
It embeds a loopback-only proxy, so it reads the same `.env` and needs nothing
else running.

```
 ◉ ARGUS  GLOBAL SIGNALS TERMINAL                             DEMO DATA  2,952 km across  09:45:04Z
⢈↑      ◉135◉    130W⢆    125W    120W     115W   ←110W     ⡁│ LAYERS
⠠ ◉     ←⠄       ⠠   ⡨⠂   ⠄       ⠠      ◉ ⠄∙Calgary        ⠄│ 1 ● Flights       40
50N ⡀◉⡀ ⡀⠂⡀ ⡀ ⡀ ⡀⠐⡀ ⡈⠢⣄ ⡀ ⡂ ⡀ ⡀ ⡀ ⡐→⡀ ⡀ ⡀ ⡀⠂⡀ ⡀ ⡀ ⡀⠐⡀ ⡀ ⡀ ⡀ ⡂│ 2 ● Earthquakes   14
⢈ ←      ⡁       ⢈     ⠑⠤⡀⡁  ∙Vancouver    ⡁       ⢈        ⡁│ 6 ● Transit       no covered agency~
⠠   ◉    ⠄       ⠠       ⠈⠦→      ⠠    O   ⠄       ⠠        ⠄│ 7 ● Surveillance  30
⠐        ⠂       ⠐        ⠂↑⡀ ∙Seattle     ⠂  ↗    ⠐        ⠂│ 3 ○ Satellites
⢈        ⡁       ⢈        ⡁ ⡇     ⢈       ↑⡁       ⢈        ⡁│ 4 ○ Fires
⠠        ←       ⠠        ⠄ ⡇    ◉⠠  ◉     ⠄       ⠠        ⠄│ 5 ○ Ships
45N ⠄ ⠄ ⠄⠂⠄ ⠄ ⠄ ⠄⠐o ⠄ ⠄◉⠄ ⠆ ⡇ ∙Portland ⠄ ⠄⠂⠄ ⠄ ⠄ ⠄⠐⠄ ⠄↙⠄ ⠄ ⠆│ 8 ○ Military air
⢈        ⡁◈      ⢈        ↙⢀⠇     ⢈        ⡁       ⢈        ⡁│ 9 ○ BGP
⠠→       ⠄       ⠠        ⠄⡸O◈    ⠠        ⠄       ⠠        ⠄│   ○ My receiver
⠐        ⠂       ⠐        ⠂⢇      ⠐→       ⠂       ⠐        ⠂│   ○ Landmarks
⢈        ⡁      ◈⢈  O     ◈⢸◉     ⢈↙       ⡁      ←⢈ ↗      ⡁│   ○ Shodan
⠠       ◉⠄       ⠠        ⠄◉◉     ⠠     ↙  ⠄     ↖↓⠠    ↓   ⠄│ +11 more (:layer NAME, or :layers)
40N ⠂ ⠂ ⠂⠂⠂ ⠂ ⠂↓⠂⠐⠂ ⠂ ⠂ ⠂ ⠂⠘⡆ ⠂ ⠂ ⠒ ⠂ ↑ ⠂ ⠂⠂⠂ ⠂ ⠂ ⠂⠐⠂ ⠂ ⠂ ⠂ ⠂│
```

(A real frame from `argus tui --demo` with Surveillance on, rendered headless at
100 columns and cropped to the top rows; in a terminal it is in colour.)

Keys: arrows or `hjkl` pan, `+`/`-` or the mouse wheel zoom, `1`-`9` toggle
the first nine layers (click or tap any row in the side panel, or `:layer NAME`,
for the rest), `Tab` cycles through what is in view, `Enter` tracks it, `:` opens the
command line (`goto`, `track`, `query`, `correlate`, `layer`, `preset`, `find`,
`export`, `status`), `c` the CT ticker, `?` help, `q` quit. Set `ARGUS_HOME=lat,lon`
(or `--at`) for "Around Me", since a terminal has no GPS. The terminal shares
the globe's newer layers where they make sense as glyphs (fire perimeters, dams,
both receiver bands, the visual satellites) and its offline place list.

The same engine answers one-shot commands, for example:

```bash
argus route "San Francisco" "Los Angeles" --mode car   # OSRM turn-by-turn (needs the network)
argus measure London Paris     # great-circle distance and bearing, offline for bundled places
argus help                     # everything else
```

## Architecture

```
core/            shared engine: Layer SDK, data integrations, proxy client, Cesium
                 scene, interpolation, SGP4, presets, search, OSINT console,
                 the ctOS UI components (core/ui) and the tracking overlay
shell-mobile/    phone: compact bar, tabbed bottom sheet, touch + S Pen,
                 Around Me, compass, PWA
shell-desktop/   Linux / Windows browser: bar, tabbed menu, target panel, status
                 strip, mouse + keyboard
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
  Public traffic-camera stills are displayed as published, on request; nothing
  analyses them.
- Aircraft owners, vehicle plates and other person-level fields are never shown:
  adsbdb's owner fields are dropped on parse, and adsb.lol trace details are never read.
- Tracking boxes and IDs are drawn from feed positions only; nothing looks at imagery.
- OSINT inputs are assets (IP, domain, ASN), never people. Anything else is refused.
- Lookups read published indexes (RIPEstat, Shodan's existing scans, CT logs, RIS);
  nothing scans or sends traffic at a host.
- Cockpit news is searched by the place name under the aircraft, never by free text.
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
