# Argus setup

How to install, run, and connect live data on Kali (the primary research
machine), any other Linux, Windows, and the phone. The key list is OS-independent.

There are three ways to use Argus, all from one checkout:

1. **The globe in a browser** on the PC (`npm start`).
2. **The globe on the phone**, served from the PC over Wi-Fi (`npm run start:https`),
   or run entirely on the phone with no PC at all: the Android app
   ([Android app](#android-app-no-pc-no-termux), which also adds Argus to
   Android Auto) or Termux ([Android standalone](#android-standalone-termux-no-pc)).
3. **The terminal version** in any terminal, including over SSH and in Termux
   (`npm run tui`).

The globe is CesiumJS and needs a browser with working GPU acceleration (see
[WebGL / GPU](#5-webgl--gpu-the-globe-only)). The terminal version needs no GPU.

---

## 1. Install

### Node.js

Vite 7 needs **Node 20.19+ or 22.12+**. Kali's packaged Node can be older:

```bash
node -v                                   # need >= 20.19 (or >= 22.12)

sudo apt update && sudo apt install -y git curl
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL
nvm install 22
```

On Windows, install Node 22 LTS from nodejs.org (or `winget install OpenJS.NodeJS.LTS`).

### Kali / Linux (recommended: the install script)

```bash
git clone https://github.com/H4ch1Net/argus.git
cd argus
./scripts/install-linux.sh
```

It is safe to re-run. It:

- runs `npm install` (one install covers the app, the proxy, and the terminal version),
- links an `argus` command into `~/.local/bin`,
- creates `~/.config/argus/.env` (mode 600) for your keys if you have no `.env` yet,
- adds **Argus** and **Argus Terminal** to the applications menu,
- checks that OpenGL is hardware accelerated (the globe refuses software rendering),
- checks for the JetBrains Mono font and, if it is missing, prints the `apt`
  command to add it (it installs no system packages itself, so it never needs root).

Options: `--no-install`, `--no-desktop`.

### Manual (any OS)

```bash
git clone https://github.com/H4ch1Net/argus.git
cd argus
npm install
```

Optional: `npm link` puts an `argus` command on your PATH (works on Windows too).
Without it, use `node bin/argus.js <command>` or the npm scripts below.

### Font (optional, for the intended look)

The interface is set in JetBrains Mono (the ctOS design uses it everywhere).
Argus does not download fonts: it uses the copy installed on the device, and
without one it falls back to the next monospace it finds (Cascadia Mono on
Windows, DejaVu Sans Mono on most Linux, the system monospace on a phone).
Everything works either way; only the look changes. On Kali or Debian:

```bash
sudo apt install -y fonts-jetbrains-mono
```

Then reload the page. The JetBrainsMono Nerd Font, if you already use it, is
picked first.

---

## 2. Run

### The globe on this machine

```bash
npm start                  # or: argus web --open
```

This builds the app the first time (and again whenever the source changes),
then serves the app **and** its proxy from one address, `http://localhost:8787`.
Live feeds work immediately for every keyless source. Stop with Ctrl-C.

### The globe on the phone (same Wi-Fi)

```bash
npm run start:https        # or: argus web --https
```

It prints a `LAN / phone` address such as `https://192.168.1.20:8787`. Open that
on the phone and accept the certificate warning (the generated certificate is
kept in `~/.config/argus/tls`, so restarting Argus does not change it). HTTPS is
required: without it the phone silently disables location ("Around Me", the
locate button), the compass / point-at-sky mode, and app install.

If the phone cannot connect, allow the port through the firewall:

```bash
sudo ufw allow 8787/tcp                   # only if ufw is active
```

To keep the proxy (and your keys) reachable from this machine only, set
`PROXY_HOST=127.0.0.1`.

#### Install it as an app on the phone (optional)

Chrome and Samsung Internet only offer "Install app" and enable offline caching
for HTTPS with a **trusted** certificate. A self-signed one is fine for using
the site but not for installing it. With [mkcert](https://github.com/FiloSottile/mkcert):

```bash
sudo apt install -y mkcert libnss3-tools
mkcert -install
mkdir -p ~/.config/argus/tls
mkcert -key-file ~/.config/argus/tls/lan-key.pem -cert-file ~/.config/argus/tls/lan-cert.pem \
  localhost 127.0.0.1 "$(hostname)" 192.168.1.20      # your LAN IP
```

Add to `.env` (or `~/.config/argus/.env`):

```bash
PROXY_TLS_KEY=/home/<you>/.config/argus/tls/lan-key.pem
PROXY_TLS_CERT=/home/<you>/.config/argus/tls/lan-cert.pem
```

Then copy the mkcert root (`mkcert -CAROOT` shows where `rootCA.pem` is) to the
phone and install it: Settings, Security and privacy, More security settings,
Install from device storage, CA certificate. Reload the page and use the browser
menu's "Install app" / "Add to Home screen".

### Android app (no PC, no Termux)

The simplest way onto the phone: install `argus-android.apk` from the
repository's releases page (`android-latest` for the newest build of `main`,
or a numbered release) and open it. The app runs the proxy on the phone and
shows the globe full screen; keys go in its SETUP tab or in Settings (long-press
the icon), stay in the app's private storage, and never reach the page. It
also puts Argus in Android Auto as a map app (a sideloaded app needs Android
Auto's developer setting "Unknown sources" once). Everything about it,
including Android Auto setup and building the APK yourself, is in
**[docs/ANDROID.md](docs/ANDROID.md)**.

### Android standalone (Termux, no PC)

The whole thing (proxy, globe, terminal version) also runs on the phone itself
in [Termux](https://termux.dev). Install Termux from F-Droid or its GitHub
releases (the Play Store build is outdated), then in Termux:

```bash
pkg install -y git
git clone https://github.com/H4ch1Net/argus.git
cd argus
bash scripts/install-termux.sh
```

The script installs Node.js and git from Termux's repository, runs
`npm install` (the lockfile already carries the Android arm64 builds of Vite's
native helpers), puts `argus` on Termux's PATH, creates a private
`~/.config/argus/.env` for keys, builds the web app once, and adds home-screen
shortcuts for the optional Termux:Widget app. It is safe to re-run after a
`git pull`.

```bash
argus web --open      # serve on the phone and open http://localhost:8787 in Chrome
argus tui             # the terminal version, inside Termux
```

On the phone, `http://localhost` counts as a secure origin, so location
("Around Me"), the compass mode, and "Install app" all work with **no
certificate at all**. Install it from Chrome's menu for a full-screen globe.
Keep the server alive with the screen off with `termux-wake-lock` (the
"Argus globe" widget shortcut does this for you), and allow Termux to ignore
battery optimization in Android's app settings if the server stops in the
background.

The phone's GPU (Adreno 830 on the S25 Ultra) runs the globe at the phone
quality tier; the thermal ladder backs quality off if it heats up.

On Android, `argus web` listens on the phone only (127.0.0.1), because a phone
is often on public Wi-Fi and the proxy holds your keys. To share it with
another device on a network you trust, start it with `argus web --host 0.0.0.0`
and use the phone's Wi-Fi IP (Settings, About phone, Status); the
PC-serves-phone setup above is usually the better fit for that.

### The terminal version

```bash
npm run tui                # or: argus tui
argus tui --demo           # simulated data, no network
argus tui --at 51.5,-0.12 --span 4 --layers flights,quakes,bgp
```

It starts its own loopback-only proxy (reading the same `.env`), so nothing
else needs to be running. To use a proxy that is already up (for example the
one serving the phone): `argus tui --proxy http://localhost:8787`.

| Key                       | Action                                    |
| ------------------------- | ----------------------------------------- |
| arrows or `h j k l`       | pan (Shift for bigger steps)              |
| `+` `-`, PgUp PgDn, wheel | zoom (the wheel zooms toward the mouse)   |
| drag with the mouse       | pan                                       |
| `1`-`9`                   | toggle a layer                            |
| `Tab` / Shift-Tab         | select the next / previous entity in view |
| `Enter`                   | track the selection (the map follows it)  |
| click                     | select the nearest entity                 |
| `Esc`                     | stop tracking, then clear the selection   |
| `p`                       | cycle presets; `a` Around Me              |
| `c`                       | Certificate Transparency ticker           |
| `g` / `n` / `i`           | graticule / place names / side panel      |
| `Space`                   | pause motion (data keeps arriving)        |
| `:` (or `/` for find)     | command line; `?` help; `q` quit          |

Commands (the same language as the in-app terminal on the globe):
`goto <lat,lon> | <place>`, `track <callsign|name|id>`, `query <ip|domain|asn>`,
`correlate <ip|domain|asn>`, `layer <id> on|off`, `layers`, `preset <name>`,
`presets`, `zoom in|out|<n>`, `world`, `find <text>`, `export <file.json>`,
`status`, `clear`, `help`, `quit`.

A terminal has no GPS, so "Around Me" uses a home position you choose: start
with `--at LAT,LON` or set `ARGUS_HOME=LAT,LON` in your shell or `.env`.

Unicode braille needs a UTF-8 locale (Kali's default). On a bare console or an
odd font use `--ascii`; `--no-color` (or `NO_COLOR=1`) turns colour off.

The coastline is a coarse built-in outline on the very first run, replaced by
Natural Earth (fetched once through the proxy, cached in `~/.cache/argus`) as
soon as it is available.

### Scripting (passive lookups and feeds)

Every command prints a table, or JSON with `--json`, and exits non-zero on failure:

```bash
argus query 8.8.8.8                       # RIPEstat: prefix, ASN, operator, location
argus correlate example.com --json        # + Shodan host exposure when keyed
argus quakes --min 4.5 --feed all_week
argus flights --near "Los Angeles" --radius 40
argus sats --group stations
argus fires --near 37.5,-119.6 --radius 200
argus geocode "Brandenburg Gate"          # offline places first, then Photon, then Nominatim
argus route "Oslo" "Bergen" --mode car    # OSRM turn-by-turn (car, foot or bike); or "A to B"
argus measure 51.5,-0.12 48.86,2.35       # great-circle distance and bearing, no network needed
argus bgp --count 20                      # sampled RIPE RIS Live updates
argus ct                                  # CT issuance stream (Ctrl-C to stop)
argus health                              # which feeds have their keys
```

`query` and `correlate` only accept network assets (IP, domain, ASN). They read
published indexes; nothing is sent to the host you ask about. `geocode`,
`route` and `measure` take places or coordinates. `measure` on coordinates or
bundled place names, and `geocode` on an exact bundled name, make no outbound
request. `route` asks the FOSSGIS OSRM servers through the proxy and refuses
legs over 600 km or routes over 2,500 km, to stay inside their usage policy.

---

## 3. Keys

Keys are read **only by the proxy** (server side) from, in order of precedence:
your shell environment, `ARGUS_ENV_FILE`, `<repo>/.env`, `<repo>/proxy/.env`,
`~/.config/argus/.env`. Never put a key in a `VITE_`-prefixed variable (Vite
copies those into the browser bundle). Restart Argus after editing.

### Works with no key

| Layer / feature                                                    | Source                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Flights (when OpenSky has no key)                                  | adsb.lol community ADS-B API (see note)                                                                                                |
| Military aircraft                                                  | adsb.lol military list                                                                                                                 |
| TRACE 24H (earlier track of a selected aircraft)                   | adsb.lol trace files (an undocumented path its own map uses; ODbL)                                                                     |
| Aircraft type, registration, route rows                            | adsbdb (owner fields dropped; route data shown at run time only, per its terms)                                                        |
| Earthquakes                                                        | USGS                                                                                                                                   |
| Satellites, navigation, GEO and visual satellites, Starlink dense  | CelesTrak                                                                                                                              |
| Launches, launch REPLAY                                            | Launch Library 2 (15 calls/hour; the proxy caches and caps at 12)                                                                      |
| Transit                                                            | GTFS-Realtime: MBTA, CapMetro, Metro Transit, HSL, OVapi, Entur, TransLink                                                             |
| Bikeshare                                                          | GBFS from 16 systems (Lyft cities, Bluebikes, BCycle, ...)                                                                             |
| Wind                                                               | Open-Meteo current 10 m wind on a grid over the view (CC BY 4.0; the proxy allows 120 requests a day)                                  |
| Cyclones, storm cones and tracks                                   | NOAA National Hurricane Center, NHC GIS MapServer                                                                                      |
| Fire perimeters (US)                                               | NIFC WFIGS current interagency perimeters                                                                                              |
| IR clouds, GOES IR, US radar, lightning density, weather history   | NOAA nowCOAST (WMS, GetCapabilities for the observation times)                                                                         |
| Recent imagery                                                     | NASA CMR (HLS search), GIBS (tiles), Worldview Snapshots (previews)                                                                    |
| Traffic cameras                                                    | Caltrans, TfL JamCams, Statens vegvesen, Ontario 511, DriveBC, Calgary, Fintraffic, TxDOT, City of Austin, Tarktee, Tallinn, Warendorf |
| Radio, radio tuner                                                 | Radio Browser (streams come straight from each broadcaster)                                                                            |
| Landmarks, surveillance cameras, data centres, dams, installations | OpenStreetMap Overpass (see note)                                                                                                      |
| Submarine cables                                                   | TeleGeography (CC BY-NC-SA 3.0, non-commercial)                                                                                        |
| Search / fly-to                                                    | Bundled places (offline), then Photon (komoot), then OSM Nominatim                                                                     |
| Directions (TOOLS > ROUTE, `argus route`)                          | OSRM on the FOSSGIS servers (routing.openstreetmap.de)                                                                                 |
| Cockpit briefing (desktop)                                         | Nominatim reverse, Open-Meteo, Google News RSS (personal use), GDELT                                                                   |
| OSINT lookups + BGP activity                                       | RIPEstat / RIPE RIS Live                                                                                                               |
| 3D aircraft models (close range)                                   | Bundled glTF files in `public/models` (CC BY 4.0, credited there and in DATA CREDITS); no network                                      |
| Basemaps, labels, 3D terrain                                       | Esri World Dark Gray Canvas, World Imagery, reference label tiles and World Elevation; OSM streets; Natural Earth (offline)            |
| Terminal coastlines                                                | Natural Earth via world-atlas (jsDelivr)                                                                                               |

Note: adsb.lol's public API was keyless when this was built, with a key (issued
to people who feed data to adsb.lol) announced for the future. Its terms could
not be re-checked from the build environment; if it starts requiring a key, use
OpenSky.

Note: everything ported from the reference project (military, transit,
bikeshare, launches, cyclones, weather, traffic cameras, radio, cables, data
centres, installations, and in the latest round storm cones and tracks, fire
perimeters, dams, GOES IR and the weather timeline, wind, recent imagery, traces,
adsbdb, routing, Photon, the nine new camera networks, the cockpit briefing
sources and TomTom traffic flow) uses the endpoints that project uses live, but
none could be reached from the build environment: each is marked "per the
reference implementation, not live-tested here" in the proxy's feed registry.
If one shows an error, `argus health`, the ERR row's hover text in LAYERS, and
the notification say why; [docs/COMPARISON.md](docs/COMPARISON.md) lists each
source and TOOLS > DATA CREDITS its terms.

Note: public Overpass servers rate-limit hard and refuse clients that do not
identify themselves (Argus sends a descriptive User-Agent). If OSM layers keep
failing, point `OVERPASS_URL` at another instance, ideally one you run.

### Free key required

| Layer            | `.env` variable(s)                           | How to get it                                                                                                                                                                                                                                                                                                                                                          |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flights**      | `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | Register at opensky-network.org, log in, **Account**, **API Client**: create a client; it gives a client id + secret (OAuth2).                                                                                                                                                                                                                                         |
| **Fires**        | `FIRMS_MAP_KEY`                              | firms.modaps.eosdis.nasa.gov/api/map_key, enter your email; the MAP_KEY is emailed instantly.                                                                                                                                                                                                                                                                          |
| **Ships (AIS)**  | `AISSTREAM_API_KEY`                          | Sign up at aisstream.io, **API Keys**, create one.                                                                                                                                                                                                                                                                                                                     |
| **Traffic flow** | `TOMTOM_API_KEY`                             | Free tier at developer.tomtom.com (about 200,000 tiles a month as recorded; re-check). The proxy injects it into TomTom's raster flow tiles, caps them at 6,000 a day and caches each for 120 s. Without it the "Traffic flow" layer is not offered. The raster tile path follows TomTom's documented pattern but is unverified (the reference used the vector tiles). |

### Optional / conditional

| Layer                  | Variable                            | Notes                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Shodan**             | `SHODAN_API_KEY`                    | Awareness only (credit-free count and host queries). Free with a student `.edu` email via the GitHub Student Pack; otherwise a paid account.                                                                             |
| **Photoreal 3D Tiles** | `GOOGLE_MAPS_API_KEY`               | Google Maps Platform key. Free monthly tier but requires billing on a Google Cloud project. Without it the "Photoreal" toggle falls back to 3D terrain.                                                                  |
| **CT firehose**        | `CT_STREAM_URL`                     | A CertStream-compatible websocket. The public server is often silent; a self-hosted certstream-server works.                                                                                                             |
| **My receiver**        | `LOCAL_ADSB_URL`                    | Your own ADS-B decoder's data folder, e.g. `http://localhost:8080/data` (see below). Must be this machine or the LAN.                                                                                                    |
| **My receiver (UAT)**  | `LOCAL_UAT_URL`                     | Your own 978 MHz UAT decoder (dump978-fa + skyaware978), same `aircraft.json` shape, e.g. `http://localhost:8978/data`. Either receiver alone enables the layer; with both, they merge. Must be this machine or the LAN. |
| **Launches**           | `LL2_API_TOKEN`                     | Optional; raises Launch Library 2's keyless 15 calls/hour.                                                                                                                                                               |
| **Traffic cams (TfL)** | `TFL_APP_KEY`                       | Optional; raises TfL's anonymous limit for the JamCam catalogue.                                                                                                                                                         |
| **Overpass / Radio**   | `OVERPASS_URL`, `RADIO_BROWSER_URL` | Optional: another Overpass instance; one fixed Radio Browser mirror.                                                                                                                                                     |

### Your own ADS-B receiver (RTL-SDR on Kali)

With an RTL-SDR dongle and a 1090 MHz decoder, the "My receiver" layer shows
the aircraft your own antenna hears, polled every 2 seconds, alongside (or
instead of) the internet feeds. Any decoder that serves `aircraft.json` works
(dump1090-fa, dump1090-mutability, readsb, tar1090). On Kali, for example:

```bash
sudo apt install -y dump1090-mutability lighttpd   # one option; readsb or dump1090-fa work too
# Where aircraft.json lives depends on the decoder, typically:
#   dump1090-mutability + lighttpd   http://localhost/dump1090/data/
#   dump1090-fa (SkyAware)           http://localhost/skyaware/data/
#   readsb + tar1090                 http://localhost/tar1090/data/
echo 'LOCAL_ADSB_URL=http://localhost/dump1090/data' >> ~/.config/argus/.env
argus health                                       # local-adsb: ready
```

The value is the folder that holds `aircraft.json` (open it in a browser with
`aircraft.json` appended to check). The proxy only accepts a
host on this machine or the LAN (loopback, 10/8, 172.16/12, 192.168/16,
`.local`), and never follows a redirect, so the setting can never be used to reach a third-party
server. Receiving ADS-B is passive.

A 978 MHz UAT receiver (UAT is used in the United States) works the same way:
run dump978-fa with skyaware978 and point `LOCAL_UAT_URL` at the folder that
holds its `aircraft.json`, for example `http://localhost:8978/data` or
`http://piaware.local/skyaware978/data`. `argus health` then lists `local-uat`.
Either receiver alone enables "My receiver"; with both, the two bands are
polled in parallel and merged into one aircraft list, and one being down never
hides the other. The terminal version reads both too. (UAT support follows the
reference implementation and has not been run against a real dump978.)

### Always simulated

The CCTV projection layer (the pose gizmo) and threat arcs have no verified
public feed, so they are always synthetic and stay labelled `DEMO` in the UI.
Real public camera stills are in the separate "Traffic cams" layer.

### Minimal live `.env`

```bash
OPENSKY_CLIENT_ID=your_id
OPENSKY_CLIENT_SECRET=your_secret
FIRMS_MAP_KEY=your_map_key
AISSTREAM_API_KEY=your_key
```

Check what the proxy sees with `argus health`.

---

## 4. Navigation and what you will see (globe)

The interface is ctOS-styled: terse uppercase labels, square frames, grays,
with green and red only for state. What follows uses the labels as they appear
on screen.

- **Layout (desktop)**: the bar across the top holds the ARGUS lockup, MENU (M),
  the preset cells (NEAR = Around Me, SKY, WATCH = Surveillance, HAZ = Disaster,
  ENV = Environment, NET = Internet), the FPS meter (frames actually drawn in the
  last second, 000 when idle) and the OBJ meter (contacts in view), then SEARCH,
  the feed state (`-LIVE--` or `-DEMO--`), the UTC time and TGT (T). The menu on
  the left has three tabs, LAYERS / VIEW / TOOLS; the target panel is on the
  right; the bottom strip shows POS / ALT / HDG, WIND (while the wind layer is
  on), the timeline and TERM.
- **Layout (phone)**: a compact bar (lockup, SEARCH, feed state), the view stack
  on the right, and a bottom sheet with LAYERS / TARGET / VIEW / TOOLS. Drag the
  grip or the tab row between peek, half and full; tapping a tab opens it. The
  presets sit at the top of LAYERS, the timeline is in TOOLS, and the
  point-at-sky compass mode is the SKY button at the top of VIEW.
- **Zoom and view**: the view stack's **+ / -** cells are the dependable option
  on a laptop trackpad (hold to repeat). Mouse wheel and two-finger scroll also
  zoom; left-drag rotates; right-drag (or middle-drag) tilts. On the phone:
  pinch to zoom, two fingers to tilt. Below the zoom cells: **N** turns north up,
  **TLT** switches between straight down and an oblique view, **⌂** returns to
  the whole Earth, **GEO** flies to your position (it asks for location).
- **Selecting a contact**: click or tap it. The camera does not move: the target
  panel opens with the tracking widget, the card (fields, a camera still where
  there is one, source links) and actions: **FOLLOW** (F) keeps the camera with
  it at the current distance, **FLY TO** goes there, **COCKPIT** (C, moving
  contacts only, not on the minimal tier) rides along, and per layer **TRACE
  24H** (aircraft: the last day of track), **NEXT PASS** (satellites), **REPLAY**
  (launch pads: a reconstructed estimate) and **NEAREST CAM** (when Traffic cams
  is on). Under the card, **CONTACTS** lists the nearest contacts with the same
  two-digit IDs as the map. **Esc** (or the panel's ESC, or a tap on empty
  space) releases the target. On the phone the sheet opens to half on TARGET
  and the target glides into the free area above it.
- **Tracking overlay**: boxes with two-digit IDs on the contacts nearest the
  middle of the view, the selected target as hub 00 (TRACK, or LOCK in green
  while following), and a frame with corner readouts. VIEW > TRACKING sets the
  density (OFF / LOW / MED / HIGH; LOW on the minimal tier) and turns the frame off.
- **Search**: `/` or Ctrl+K (or SEARCH in the bar) opens the launcher: contacts in
  the active layers, places (the bundled list first, so common cities work
  offline) and network assets (an IP, domain or ASN runs the passive lookup).
- **Terminal**: the backtick key, TERM in the strip, or TOOLS > CONSOLE.
- **Layers** are grouped (Air & space, Ground & sea, Earth & weather,
  Infrastructure, Signals); type in the LYR field to filter. Each row shows its
  state on the right: a count, LOAD, OFF, N/A, or ERR in red (hover for the
  reason); a failing feed also raises one notification. ALL OFF clears the map.
  Presets switch a sensible set at once.
- **VIEW**: BASEMAP (DARK, the default on capable unmetered devices; SAT; STREETS;
  RELIEF, offline, the default on metered or minimal devices) and MONO (grayscale,
  dimmed imagery); LABELS (CITY NAMES from the bundled list, offline; PLACES +
  BORDERS and STREET NAMES from Esri reference tiles); TRACKING; TERRAIN (Flat,
  3D Terrain, Photoreal); 3D MODELS (aircraft within 150 km drawn as glTF models
  of their class below 800 km of camera height; on by default on the desktop, off
  on the phone, absent on the minimal tier); SATELLITES (Starlink dense, full
  tier only); WEATHER
  HISTORY; SENSOR (NVG, FLIR, Noir; Snow, CRT, sharpen and bloom on the desktop
  only; none on the minimal tier); SYSTEM (the capability readout).
- **TOOLS**: ROUTE (tap A and B on the map, or use the selected target, pick car,
  foot or bike, GO, then FLY ALONG), DRAW + MEASURE (areas, lines, pins: tap to
  add points, DONE to measure), RECENT IMAGERY (PICK AREA, then a day), SHARE
  (COPY LINK; the address bar always holds the current view, so a reload keeps
  it), RADIO (the tuner), CONSOLE, CERTIFICATE TRANSPARENCY, DATA CREDITS. While a
  tool waits for a map tap, a notice says so and Esc cancels.
- **OSM layers load only when you zoom in.** Surveillance cameras, landmarks,
  dams and installations come from Overpass, which is only queried once the
  view covers a city-sized area (under about 3 degrees; data centres up to 6).
  The row says "zoom in to load" until then.
- **City feeds**: transit, bikeshare and traffic cameras cover specific cities and
  regions (listed in `docs/COMPARISON.md`); elsewhere the row says none is in
  view. Transit is on by default and fills in when you reach a covered city.
- **Weather**: IR clouds are global, GOES IR covers the Americas, radar the
  contiguous US, lightning the Americas and Pacific. They show the latest frame
  by default; VIEW > WEATHER HISTORY steps them back together through the last
  day of observations, plays the loop, or returns to LIVE.
- **Cards** carry links to the source (an NHC advisory, a radio stream, a camera's
  still). Opening a radio stream, or PLAY in the tuner, connects your device
  directly to the broadcaster.
- **Earthquakes** are real, sparse events: you may see none over your town.
- **Live vs demo**: if the app cannot reach a proxy, the bar reads `-DEMO--` and
  a `DEMO DATA` notification says every layer is simulated. A layer whose key is
  missing shows ERR in LAYERS (hover it for the proxy's reason).
- **Heat**: on a phone that is getting hot, the `thermal` row in VIEW > SYSTEM
  shows what Argus has turned down (post-processing, then resolution, then
  terrain), and a THERMAL BUDGET notification says so. It recovers on its own
  after a few minutes of comfortable frame times.

---

## 5. WebGL / GPU (the globe only)

Open Chromium and go to `chrome://gpu`. Read the top block:

- **`WebGL: Hardware accelerated`**: good, skip the rest of this section.
- **`WebGL: Software only`**, or it mentions `SwiftShader` / `llvmpipe`: Cesium
  will show a "Hardware acceleration required" screen instead of the globe. Fix
  it below, or use the terminal version meanwhile.

**Bare-metal Kali (real GPU):**

```bash
sudo apt install -y mesa-utils
glxinfo -B | grep "OpenGL renderer"       # should name your GPU, not "llvmpipe"
```

If it says `llvmpipe`, the GPU driver is not loaded (install the vendor driver:
`mesa-vulkan-drivers`, the right `firmware-*` package, or the NVIDIA driver). On
hybrid Intel + NVIDIA laptops, try launching the browser with
`__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia`.

**Kali inside a VM (most common):**

- **VMware**: VM Settings, Display, enable **Accelerate 3D graphics**, give it 1-2
  GB video memory, install `open-vm-tools`. Works well.
- **VirtualBox**: WebGL/3D support is poor and usually will **not** satisfy
  Cesium. Prefer VMware or bare metal, or use `argus tui`.
- **QEMU/KVM**: use `virtio-gpu` with virgl
  (`-device virtio-vga-gl -display gtk,gl=on`) and install `mesa-utils` in the
  guest.

**Last resort** (only if `glxinfo` shows a real GPU but Chromium still reports
software): launch with the blocklist off. Do not force software rendering.

```bash
chromium --ignore-gpu-blocklist --enable-gpu-rasterization http://localhost:8787
```

Firefox works too: check `about:support`, "WebGL 2 Driver Renderer" names your GPU.

---

## 6. Windows

Everything above works from PowerShell or Windows Terminal: `npm install`,
`npm start`, `npm run start:https`, `npm run tui`. For the phone, allow Node
through Windows Defender Firewall when prompted (private networks). Keys go in
`.env` in the repo, or `%USERPROFILE%\.config\argus\.env`. The terminal version
works best in Windows Terminal (UTF-8 and mouse support built in).

---

## 7. Development

```bash
npm run dev                # Vite dev server on :5173 (hot reload)
npm run proxy              # in a second terminal, for live data
npm run dev:https          # dev server over HTTPS, to test on the phone
```

The dev server forwards `/health`, `/feed`, `/tiles`, and `/ws` to the proxy on
`localhost` (following `PROXY_PORT` and `PROXY_HTTPS` from the same `.env` files
the proxy reads), so the app always talks to its own origin (that is what makes
the phone work over HTTPS). With no proxy running, the dev build falls back to
labelled demo data. `ARGUS_PROXY_TARGET` points the forwarding elsewhere (`off`
disables it); `VITE_PROXY_BASE_URL` makes the app call a proxy on another origin
directly.

```bash
npm test                   # core, mobile shell, terminal shell (node --test)
npm run test:proxy         # proxy
npm run lint
npm run format:check
node scripts/make-icons.js # regenerate the PWA icons
```

Force a shell regardless of device with `?shell=mobile` or `?shell=desktop`.

---

## 8. Troubleshooting

| Symptom                                  | Fix                                                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| "Hardware acceleration required"         | Section 5. Meanwhile `argus tui` works without a GPU.                                                                 |
| `DEMO DATA` notice, `-DEMO--` in the bar | The app cannot reach a proxy: use `npm start`, or run `npm run proxy` next to `npm run dev`.                          |
| A layer row shows `ERR`                  | Its key is missing or the upstream failed; hover the row, read the notification, or run `argus health`.               |
| The UI font looks plain                  | JetBrains Mono is not installed: `sudo apt install fonts-jetbrains-mono`, then reload (section 1).                    |
| No "Traffic flow" layer                  | It is offered only when the proxy has `TOMTOM_API_KEY` (section 3); restart after adding it.                          |
| Clicking a contact does not zoom in      | By design: selecting never moves the camera. Use FOLLOW (F) or FLY TO in the target panel.                            |
| Ships / BGP / CT never appear            | Run `npm install` (the proxy's websocket support comes from the `ws` package); ships also need the key.               |
| Phone: no location, compass, or install  | Use the `https://` address (`npm run start:https`); install also needs a trusted cert (section 2).                    |
| Phone cannot reach the PC                | Same Wi-Fi? Firewall port 8787 open? Use the printed LAN address, not `localhost`.                                    |
| Termux: `npm install` fails              | `pkg upgrade`, then re-run `bash scripts/install-termux.sh` (needs Node 20.19+ or 22.12+).                            |
| OSM layers fail (429, 406, timeouts)     | Public Overpass is busy or refusing: wait, zoom in further, or set `OVERPASS_URL` to another instance.                |
| No "My receiver" toggle                  | Set `LOCAL_ADSB_URL` and/or `LOCAL_UAT_URL` to your decoder's data folder (section 3), restart, check `argus health`. |
| Transit / bikeshare / cameras empty      | They cover specific cities; the LAYERS row says "zoom to a covered city" or "none in view".                           |
| Termux: server stops with screen off     | `termux-wake-lock`, and exempt Termux from battery optimization in Android's app settings.                            |
| `EADDRINUSE :8787`                       | Something already uses the port: `argus web --port 8790`.                                                             |
| Terminal map shows boxes or `?`          | Use a UTF-8 locale and a font with braille, or `argus tui --ascii`.                                                   |
| `node: bad option` / syntax errors       | Node is too old: section 1.                                                                                           |
