# Argus

A live 3D globe (CesiumJS) that visualizes public data feeds: aircraft, ships,
satellites, earthquakes, weather, surveillance infrastructure, and internet
telemetry. A cybersecurity research project. One web app, three targets in
priority order: Samsung S25 Ultra (mobile-first), Linux, Windows.

Based on [`bilawalsidhu/gods-eye-view`](https://github.com/bilawalsidhu/gods-eye-view)
(MIT, code only; data feeds keep their own terms).

Read `CLAUDE.md` before writing code. Full rationale lives in
`docs/gods-eye-view-master-plan.md`.

## Status: all 17 phases complete

Globe + tiers (P1), proxy (P2), flights + OpenSky OAuth2 (P3), click/tap-to-track
(P4), the Layer SDK (P5), satellites + earthquakes (P6), presets + mobile shell v1
(P7), cockpit mode (P8), sensor shaders (P9), ships (AIS) + fires (P10), the
Overpass layers (P11), CCTV projection (P12), Shodan + the budget governor (P13),
compass / point-at-sky mode (P14), global search / fly-to (P15), the full
OSINT/cyber console (P16: threat-map arcs, the passive query console, multi-source
asset correlation, the live BGP layer, the CT firehose, and the in-app terminal),
and the time scrubber (P17). The build order is complete.

- **Free terrain baseline:** flat ellipsoid + Natural Earth II imagery bundled
  with Cesium. No token, no network, no secrets.
- **Base-imagery switcher (`core/scene/imagery.js`, `core/ui/imagerySwitcher.js`):**
  the offline Relief baseline, or higher-resolution **Satellite** (Esri World
  Imagery, aerial) / **Streets** (OpenStreetMap, roads + labels) so zooming in
  shows the actual street a surveillance camera or ALPR reader sits on. Both are
  keyless public tile services, opt-in on top of the baseline (cellular-friendly).
- **Capability tiers:** the runtime is probed (GPU, memory, input, network,
  screen) and mapped to `minimal | balanced | full`, which drives resolution
  scale, frame-rate cap, and render mode. The app branches on tier, never on
  "is mobile".
- **Two shells:** the entry point picks the mobile shell (bottom sheet, touch)
  or desktop shell (side panel, mouse) by form factor. Both mount the same core.
- **Proxy backbone (`proxy/`):** key/secret broker, CORS shim, HTTPS terminator,
  and an OAuth2 token manager, all in front of an allowlisted feed registry.
- **Layer SDK (`core/layers/sdk/`):** a layer is config, not code. The engine
  owns viewport-bounded fetch, the poll loop, normalize, renderType dispatch
  (`point`/`billboard` now; `raster`/`arc` are declared extension points),
  interpolation, entity lifecycle, clustering hooks, and Page-Visibility pausing.
- **Layers (all definitions on the SDK):**
  - **Flights** (`flights/`) — viewport-bounded OpenSky billboards, interpolated.
  - **Earthquakes** (`earthquakes/`) — USGS points sized/colored by magnitude.
  - **Satellites** (`satellites/`) — CelesTrak TLEs propagated by SGP4 each frame
    (`positionAt`), with an orbit ring per satellite (GMST-realigned on a timer).
  - **Fires** (`fires/`) — NASA FIRMS VIIRS points (CSV), viewport-bounded, sized
    and colored by radiative power. The MAP_KEY is injected into the URL path by
    the proxy.
  - **Ships** (`ships/`) — the first PUSH layer: AIS reports stream from the
    proxy's websocket consumer (which holds one upstream AISStream connection and
    fans out per client bbox); vessels upsert as they report and drop when stale.
  - **Landmarks** and **Surveillance** (`landmarks/`, `surveillance/`) — OSM data
    via one Overpass client. VIEWPORT-mode: fetched once per region on camera
    settle (not polled), area-gated and hard-cached. The surveillance layer maps
    the LOCATIONS of cameras and ALPR/Flock readers (`man_made=surveillance`), the
    "eyes" pillar. Guardrail: locations only, never a reading of what they see.
  - **CCTV** (`cctv/`) — public camera snapshots projected into 3D: each camera is
    a marker, a view frustum (where it looks), and its image at the frustum's far
    plane, all driven by an editable pose (`once`-fetch so poses persist). A pose
    gizmo (heading/pitch/FOV/range sliders; the S Pen suits it) appears when a
    camera is tracked. Guardrail: displays the public stream only, no CV on it.
  - **Shodan** (`shodan/`) — exposed-device density: a country-facet SNAPSHOT from
    the credit-free `/host/count` endpoint, plotted at country centroids and sized
    by a log of the count. Visualization/awareness-only, never live search-on-pan;
    inputs are assets and counts, never people. The proxy's **budget governor**
    (`proxy/lib/governor.js`) guards every metered feed with a per-feed rate limit
    and credit budget, so a session can never burn the monthly credits.
- **Presets + layers (`core/scene/layerManager.js`, `core/presets.js`):** a layer
  manager enables/disables layers; preset scenes (Around Me, Sky, Disaster) toggle
  layer sets; a preset bar and per-layer toggle pills drive it (shell-placed). The
  default-on set is flights + earthquakes; the tracker resolves picks across every
  active layer.
- **Threat-map arcs (`core/layers/threats/`, `renderType: 'arc'`):** animated
  great-circle arcs source-geo to target-geo over the globe, the ethical-hacker
  analogue of the earthquakes layer. The `arc` renderType (SDK) bows a polyline
  over the surface (`core/layers/sdk/greatCircle.js`, pure and tested) and rides a
  bright pulse along it; arcs are ephemeral push events that fade after ~15s.
  Guardrail: awareness/ambient only, never forensic attribution: IP geolocation is
  not locating a person, attackers proxy, and the endpoints are geographies, not
  people. Real source feeds (GreyNoise, honeypots) are keyed and unverified, so
  this ships on a synthetic dev stream; a verified feed drops into the same push
  contract.
- **OSINT query console (`core/osint/`):** grows straight out of the search box.
  A query that parses as a network asset (IPv4/IPv6, `ASxxxx`, or a domain, via
  `asset.js`, pure + tested) offers a passive lookup that geolocates and enriches
  it from public indexes (RIPEstat: network-info, as-overview, announced-prefixes,
  maxmind-geo-lite, dns-chain) through a new allowlisted proxy feed, then plots a
  labelled marker (`plotter.js`), tracks it, and cards the prefix / ASN / operator
  / location. Guardrail: inputs are assets (IP, prefix, ASN, domain), never
  people; every lookup is a read of an already-published index, nothing is sent at
  a host. Without a proxy, a dev build returns obviously-synthetic enrichment so
  the console is demonstrable.
- **Asset correlation (`core/osint/correlate.js`):** the same search box also offers
  "Correlate", which shows one asset across several passive sources at once, the
  composite infrastructure picture. It merges RIPEstat routing/registry (prefix,
  ASN, operator, announced-prefix footprint) with a credit-free Shodan single-host
  exposure lookup (open ports, hostnames, tags, flagged CVEs) into a sectioned
  card, and marks the correlated asset distinctly. This is the plan's
  "triangulation": multi-source correlation, never multi-point geo scatter (public
  geolocation is too coarse for that) and never people. Sources degrade gracefully
  when unconfigured; CT joins later in the stage.
- **BGP activity (`core/layers/bgp/`, `proxy/lib/risLive.js`):** the live RIPE RIS
  Live firehose, rendered as brief pulses at the RIS route collector that observed
  each update (announcements cyan, withdrawals amber), so active collectors
  "heartbeat" as routes change worldwide. The proxy holds one upstream websocket
  and fans a sampled, bounded stream out over `/ws/bgp` (the AIS-consumer pattern);
  collector geo is real, stable reference data (RIPEstat rrc-info), so no
  per-message geolocation is needed. Public, no key. Guardrail: public routing
  telemetry about the internet's own infrastructure, an asset-level view, no
  people. Without a proxy, a dev build drives it from a synthetic event stream.
- **CT firehose (`core/ui/ctTicker.js`, `proxy/lib/certStream.js`):** a live
  Certificate Transparency issuance ticker ("the internet building itself in real
  time"): newly issued certs stream in with their primary domain, issuer, and SAN
  count, plus a live issuance rate. CT has no per-cert geography, so this is an
  honest HUD, not globe dots. Off by default; toggling it connects the `/ws/ct`
  feed so the upstream socket is only held while watched. Cert domains are
  attacker-controllable, so every value is HTML-escaped on the way to the DOM. The
  public CertStream server is frequently silent (verified), so a working
  aggregator drops in via `CT_STREAM_URL`; until then a dev build streams
  synthetic certs.
- **In-app terminal (`core/ui/terminal.js`, `core/osint/terminal/commands.js`):** a
  command palette that drives the app and runs the passive lookups already built:
  `track <query>`, `layer <id> on|off|toggle`, `goto <lat,lon>|<place>`,
  `query <asset>`, `correlate <asset>`, `preset <name>` (and `help`/`layers`/
  `presets`/`clear`), with command history. Parsing is pure and tested; side
  effects go through a facade over the existing controllers, so `query`/`correlate`
  reuse the same passive search path. Guardrail from the master plan: it commands
  the app and reads public indexes only, never sending traffic at a host: no
  scanning, no packets at targets. Output is HTML-escaped (it can include
  feed-derived strings).
- **Time scrubber (`core/ui/timeScrubber.js`, `core/scene/clock.js`):** the
  front-end for the ring-buffer history. A shared scene clock is the single "now"
  the SDK positions movers against, so dragging the scrubber back rewinds every
  mover at once: flights and ships interpolate from their per-entity ring buffers
  (`ringBuffer.sampleAt` brackets any instant in the retained window), satellites
  re-propagate via SGP4 at the scrubbed time. Live by default; Play runs the frozen
  moment forward toward now, LIVE snaps back. Feed ingest and staleness always use
  real time; only display rewinds. Nothing is persisted to disk (the buffer
  evaporates on close), keeping "live only" honest.
- **Global search / fly-to (`core/search/`, `core/ui/searchBox.js`):** one search
  box queries every active layer (each layer declares a `searchText` adapter the
  SDK matches against) plus place names via OSM Nominatim through the proxy.
  Selecting an entity result tracks it; selecting a place flies there. This is the
  seed the OSINT query console grows from. Without a proxy, a dev build geocodes
  against a small built-in gazetteer so fly-to stays demonstrable.
- **Mobile shell v1:** a draggable snap-point bottom sheet holding the presets,
  toggles, readout, and card; it launches into "Around Me" (geolocation fly-to,
  graceful if denied). Sensors live only in the mobile shell.
- **Point-at-sky mode (`shell-mobile/compass.js`):** DeviceOrientation aims the
  camera from the user's location (hold the phone up to sweep the sky). A reticle
  marks the aim and the entity under it lights up in a HUD; tapping locks/tracks
  it. Requires HTTPS + an explicit permission grant on iOS; degrades gracefully.
  The desktop shell carries none of this sensor code.
- In a dev build, layers are sourced from mocks when no proxy is configured, so
  the whole app is demonstrable without credentials; production uses the proxy.
- **Interaction spine:** click or tap an aircraft (Pointer Events, with a
  finger-sized pick tolerance and tap/drag disambiguation) to track it: the
  camera follows, a fading trail draws from its ring-buffer history, it is
  highlighted, and a metadata card appears (shell-placed). Close, Escape, or a
  tap on empty space deselects.
- **Cockpit mode (`core/interaction/cockpit.js`):** for a tracked mover, a
  "Cockpit" action rides the camera behind and above the entity along its
  heading, at 60fps with a Wake Lock (both released on exit). Capability-gated
  (not offered on the weakest tier). Exit via the button or Escape (which exits
  cockpit before it would deselect); orbit-follow resumes.
- **Sensor shaders (`core/shaders/sensorShaders.js`):** NVG, FLIR, and a CRT
  overlay as Cesium post-process stages. Desktop-favored, mobile-gated: none on
  the weakest tier; balanced (phone) renders reduced-resolution single-pass
  (`textureScale 0.66`); full (desktop) runs full resolution and can stack the
  CRT overlay on a sensor mode (multi-pass, desktop-only).

### Seeing data

`npm run dev` alone shows the app with mock data (flights, quakes, satellites) so
every layer and preset is usable without any setup. For live feeds, run the proxy
with `VITE_PROXY_BASE_URL` pointing at it, plus OpenSky credentials
(`OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`) for flights; USGS and CelesTrak
need no key.

## Structure

```
/core           shared engine: capability detection, Cesium scene, net/, layers/ (Layer SDK later)
/shell-mobile   S25-tuned: bottom-sheet UI, touch + pen, phone quality defaults
/shell-desktop  Linux/Windows: side-panel UI, mouse/keyboard, quality unlocked upward
/proxy          the backbone service (key broker, CORS, HTTPS, OAuth2, AIS websocket, budget governor)
```

## Develop

```bash
npm install
npm run dev
```

Then open the printed URL. Force a shell with `?shell=mobile` or `?shell=desktop`.

Serving to the phone over LAN needs HTTPS, or geolocation, orientation, and
service workers silently no-op:

```bash
npm run dev:https
```

The dev server is already exposed on the LAN (`host: true`); open the Network
URL Vite prints on the phone.

### Tests

```bash
npm test            # core + mobile-shell pure-logic tests (node --test)
npm run test:proxy  # proxy tests (relay, cors, config, oauth)
```

### Proxy

```bash
npm run proxy       # http on :8787 (see proxy/README.md for HTTPS + credentials)
```

## Build order

See `CLAUDE.md` and `docs/gods-eye-view-master-plan.md` for the full 17-phase
plan. Phases 1 to 14 are done (through Shodan, the budget governor, and point-at-sky mode).
