# God's Eye View Clone: Master Planning Document

A live 3D globe (CesiumJS) visualizing public OSINT-style and open data feeds. Framed as an omniscient view of the world's **systems, infrastructure, and environment**. As a second focus, it also covers the **internet's own infrastructure**, as a cybersecurity research project.

This document consolidates the full planning thread. It is the source of truth; the original handoff is superseded where they differ.

---

## 1. Reference project

- Based on **bilawalsidhu/gods-eye-view** (CesiumJS-based live 3D globe, MIT licensed).
- The reference plots public data feeds (flights, ships, satellites, traffic cameras, infrastructure) on a photorealistic globe, with click-to-track, cockpit mode, and voice mode.
- **Important factual note:** the reference project does **not** read license plates or run computer vision on footage. Its CCTV layer displays already-public camera _streams_ projected into 3D. This was verified against the repo.
- MIT covers the **code only**. Third-party data and visual assets keep their own licenses and terms. The repo models this with a `DATA_SOURCES.md` that carves out non-permissive datasets rather than hiding them, a pattern worth carrying forward.

---

## 2. Guiding identity and ethical spine

The project is **omniscient over systems and the environment, not over people.** This is both the ethical framing and the technical reality (there is no public feed for surveilling identifiable individuals anyway).

**The one principle that governs every layer:** _does the artifact query things that are already public, or does it act on / identify a specific person or target?_

- Reading public, already-aggregated data (Shodan already scanned it, CT logs already recorded the cert, RIPE already published the BGP update, DeFlock already mapped the camera, OpenSky broadcasts the aircraft position) → **in scope.** This is research, situational awareness, and defensive analysis.
- Generating new surveillance of individuals, or acting against a target, → **out of scope.**

This is a cybersecurity-focused project. It does not endorse or enable misuse. The same discipline that keeps it ethical is what makes it good research: the insight lives in correlating public data, not in poking a box or tracking a person.

### Explicitly ruled OUT

- **Voice control** (no OpenAI Realtime API, no voice tooling).
- **ALPR / plate reading**: running CV on live feeds to extract and track plates. This creates new tracking data of non-consenting people regardless of storage, privacy, or "research" framing. Mapping where the cameras/readers _are_ stays in; reading what they _see_ does not.
- **OSINT aimed at people**: people-search, breach-data lookups on individuals, social-media scraping to locate someone, username→identity resolution. The tell: is the input an **asset** (IP, domain, cert, ASN, network) or a **person** (name, username, face, phone)? Assets yes, people no.
- **Active/offensive tooling**: the in-app terminal commands the app and runs _passive_ public-index lookups only. No port scanning, nmap/masscan, exploit frameworks, or sending packets at third-party hosts.

---

## 3. Architecture

### 3.1 Platform targets and priority order

**S25 Ultra (mobile-first) > Linux > Windows.**

This flips the normal default. The phone constraints are the **baseline defaults**; desktop **unlocks upward** from there. No feature in the shared core may _require_ a mouse, keyboard, or desktop GPU.

Capability is **runtime state, not a build target.** One web app detects its environment (GPU limits, memory, touch vs pointer, network type, screen size) and adapts via a **capability tier**. All three targets run Chromium, so there is no native rebuild and no bridging of runtimes, the platforms differ in hardware and input, barely in engine.

### 3.2 Shared core, two shells (chosen over separate projects)

One repo. ~80% of the code is shared and is the hard part; only ~20% (input, layout, quality) genuinely diverges. Separate projects would mean building the data engine twice and every future layer twice.

- **Core (shared):** Layer SDK, all data integrations, proxy client, Cesium scene setup, entity/trail/interpolation engine, SGP4 propagation, presets, search. One implementation. Add a layer here and both shells get it.
- **Mobile shell (S25-tuned):** bottom-sheet UI, touch + S Pen input, phone quality defaults (resolution scaling, 30fps ambient, free terrain), geolocation "around me" + compass modes, PWA manifest + service worker.
- **Desktop shell (Linux/Windows):** side-panel UI, mouse/keyboard, quality unlocked upward (photorealistic tiles, 60fps, stacked shaders, full cockpit).

Geolocation and orientation are **shell inputs, not core.** The core exposes "set camera to X" and "track entity Y"; the mobile shell translates GPS/compass into those calls, so the desktop shell never carries dead sensor code.

### 3.3 The proxy: the actual backbone

Nearly every verification pointed back to this. It is not a convenience; it is the spine. One service with these jobs:

1. **Key / secret broker**: no API secret ever touches the browser.
2. **OAuth2 token manager**: for OpenSky: fetch token, cache, refresh ~30s before expiry.
3. **CORS shim**: many feeds send no CORS headers.
4. **HTTPS terminator**: required because HTTP feeds are hard-blocked on mobile (see §6.4). Includes bare-IP and local-network endpoints that browsers won't auto-upgrade.
5. **Stateful AIS websocket consumer**: AISStream forbids direct browser connections; the proxy holds the connection and fans out only what each client needs.
6. **Rate / budget governor**: in front of every metered API (Google tiles, Shodan). Non-optional: it's what stops an afternoon of panning from burning a month of Shodan credits.

### 3.4 The Layer SDK: the scalability unlock

Every layer, physical or internet, reduces to the same shape:

`fetch (poll | push | once | compute) → normalize to common entity schema {id, position, type, meta, velocity?} → render → interpolate?`

- Define once; new layers become **config, not code**. This is what makes "everything" tractable instead of infinite.
- **`renderType` field** on each layer: `point | billboard | trail | raster | arc`. This lets the same interface handle entity layers, raster/field overlays (weather, air quality), and threat-map arcs without a parallel subsystem. **Decided: rasters handled natively via `renderType`, not a separate system.**
- **Viewport / radius-bounded fetch** baked into the signature from day one. Serves performance, credit budgets, _and_ the mobile "around me" query all at once.
- Build **clustering, viewport culling, and load-only-enabled-layers-in-view into the interface itself**, mandatory at this layer count, doubly so on the phone.

### 3.5 Stack

CesiumJS + Vite + vanilla JS (no framework). Input built on **Pointer Events** (unifies mouse, touch, and S Pen; branch on `pointerType` only where required, pen pressure for the CCTV gizmo, hover for desktop tooltips).

---

## 4. The three pillars

### Pillar 1: Ambient physical-world globe

Data rains onto the globe; you watch.

### Pillar 2: Surveillance-infrastructure map ("the eyes")

Where the sensors are. Locations of equipment, never a reading of what the equipment sees.

### Pillar 3: Passive OSINT / analysis console (cybersecurity)

Interactive lookups against public indexes. Threat-map arcs, query console, asset correlation, terminal. Staged as a later phase, built on the search subsystem. All asset-focused, all passive.

---

## 5. Full layer catalog

Layers are grouped by **family**, because the family determines render + refresh behavior. Feed terms marked **[verified this session]** were checked; all others carry a **"confirm terms at build time"** caveat, since feed availability, terms, and rate limits shift constantly.

### 5.1 Movers: poll/push + interpolate + trail (expensive)

| Layer                | Source                              | Notes                                                                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flights**          | OpenSky Network + adsb.lol          | The reference/pipeline-proving layer. **[verified]** OpenSky now requires OAuth2 client-credentials (all accounts since ~Mar 2025); anonymous = 400 credits/day @ 10s resolution (≈2.2h of use), registered = 4,000/day. Register a client, broker server-side, viewport-bound queries (credits charged by area). |
| **Ships / AIS**      | AISStream                           | **[verified]** WebSocket push, free key. **Direct browser connections forbidden**, must go through the proxy. Global feed ≈300 msg/s; if the read queue backs up they drop the connection. Compression (permessage-deflate) becomes mandatory Sept 2026. MMSI is the id.                                          |
| **Satellites**       | CelesTrak TLE + SGP4 (satellite.js) | No live feed, position computed from orbital elements (cheap to run, math-heavy). Orbit rings are the signature visual. **SGP4 + GMST realignment** keeps rings locked to satellites without drift. Refresh TLEs daily, propagate locally each frame.                                                             |
| **Transit vehicles** | GTFS-Realtime                       | The density play, makes cities feel alive. One parser unlocks hundreds of agencies, but each agency is a separate feed URL → needs an agency registry + viewport-based enabling.                                                                                                                                  |

Shared movers concerns: trail length/decay (memory grows per entity), heading interpolation across the 180° meridian, stale-fade vs hard-drop when an entity stops updating.

### 5.2 Events: timestamped points that appear/decay/vanish (forces a time dimension)

| Layer                                             | Source                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Earthquakes**                                   | USGS GeoJSON                  | Free, near-real-time. Magnitude→size/color, depth→opacity/z. The cleanest events reference.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Fires**                                         | NASA FIRMS                    | **[verified]** Free MAP_KEY, 5,000 transactions / 10-min window. Global VIIRS queries return 30k–100k+ records/day → viewport-bound mandatory. (Had shutdown-related update gaps in late 2025, a reminder even NASA feeds wobble.)                                                                                                                                                                                                                                                                                                                     |
| **Space launches**                                | Launch Library 2              | Sparse, scheduled ahead → has a _future_ dimension (upcoming launches, countdown UI).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **News / events**                                 | GDELT                         | Global geolocated firehose. Must be filtered by category/severity before rendering or it becomes visual mud.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **311 service requests**                          | Per-city open data            | Pothole/graffiti/noise reports as points. Hyperlocal, patchwork (only cities that publish).                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Emergency dispatch / CAD / 911 incident feeds** | Per-city open data / scraping | **This is the real, in-scope version of the "emergency vehicles" idea.** Some cities publish live 911/CAD _incident_ feeds (type, rough location, time). No unified source, per-city integration. You get _"structure fire reported at 5th & Main,"_ **not** an ambulance dot. **Live emergency-vehicle GPS does not exist as a public feed**, set that expectation in the UI so the layer doesn't overpromise. Related but delayed: crime data (city open data, not live); scanner audio (Broadcastify); conflict events (ACLED, registration-gated). |

### 5.3 Fields / overlays: surfaces, not entities (`renderType: raster`)

| Layer                                  | Source                | Notes                                                                                                                                                                                                                                         |
| -------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Weather radar**                      | NWS / NEXRAD tiles    | Raster draped on globe; animate recent frames for motion.                                                                                                                                                                                     |
| **Lightning**                          | Blitzortung           | Near-real-time strikes; rendered as a flickering field.                                                                                                                                                                                       |
| **Air quality**                        | OpenAQ + PurpleAir    | Station points interpolated into a heatmap surface (the points→field interpolation is the real work).                                                                                                                                         |
| **Aurora / space weather**             | NOAA SWPC             | Auroral-oval overlay at the poles. Cheap, gorgeous.                                                                                                                                                                                           |
| **Cloud / satellite imagery**          | GOES / Himawari       | Near-real-time full-disk imagery draped on the globe. Heavy but makes it look truly live.                                                                                                                                                     |
| **Live traffic flow / congestion**     | TomTom or HERE (paid) | Real-time road congestion as a colored overlay. OSM has no live flow data, so this is the one traffic layer that needs a paid API and a budget governor. Distinct from the free DOT traffic _cameras_ (§5.6). Deferred / optional given cost. |
| **Near-earth asteroids**               | NASA NeoWs            | Sparse; contextual space-awareness layer.                                                                                                                                                                                                     |
| **Day/night terminator + city lights** | Computed              | Real terminator line; contextualizes flights/satellites visually.                                                                                                                                                                             |

### 5.4 The eyes: surveillance infrastructure (locations only)

| Layer                             | Source                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Public CCTV feeds**             | City APIs (Austin, London TfL, Caltrans were reference originals)                  | Public camera _streams_ projected into 3D with pose calibration via a draggable gizmo. **Hardest visual feature** (camera pose estimation). The S Pen is the right tool for the gizmo (precision fingers lack). No CV on footage.                                                                                                                                                                                                                                      |
| **ALPR / Flock camera locations** | DeFlock.me / OSM via Overpass (`man_made=surveillance` + `surveillance:type=ALPR`) | Static points, fetch once per viewport region, cache hard, no polling loop. **Coverage/density analysis is the research payload:** which roads are blanketed, route-level reader counts, gap-finding. Mapping readers, not reads.                                                                                                                                                                                                                                      |
| **Shodan devices**                | Shodan API                                                                         | **[verified]** Students get the one-time **Membership free** via academic (.edu) email, use your CSUSB email. Membership = 100 query credits/month. **Search costs credits (1 credit / 100 results); direct IP lookups are free.** → Build as **cached/snapshot queries per region/service, visualize from cache**, never live search-on-pan. Filters are plan-gated (`vuln`, `tag` need higher tiers) → degrade gracefully. Locked: **visualization/awareness-only.** |
| **Cell towers**                   | OpenCelliD                                                                         | Tower locations, coverage estimation.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Wifi access points**            | WiGLE                                                                              | AP locations from wardriving data. RF-infrastructure sub-cluster with cell towers.                                                                                                                                                                                                                                                                                                                                                                                     |
| **Tor relays / exit nodes**       | Public Tor consensus                                                               | Relay/exit-node list plotted by geo. Static-ish, easy, thematically perfect.                                                                                                                                                                                                                                                                                                                                                                                           |
| **Landmarks / OSM features**      | Overpass API (`tourism`, `amenity`, `historic`, etc.)                              | Same Overpass client as Flock. Free, no key. **Rate-limited & slow on big bounding boxes → viewport-bounded queries + aggressive caching are a prerequisite to ship,** not an optimization. Public-instance vs self-hosted is a later decision if usage grows.                                                                                                                                                                                                         |

**Render treatment for the whole cluster:** design one consistent "sensor" glyph language (icon per type, range ring where meaningful, color by category) so the eyes read as one coherent overlay, not five unrelated point sets.

### 5.5 Passive OSINT / cyber console (Pillar 3)

| Feature                                 | Source(s)                                                                                                   | Notes                                                                                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat-map arcs (Kaspersky-style)**   | GreyNoise (mass-scanner tagging), honeypot attack-origin feeds, CISA KEV (known-exploited vulns), AbuseIPDB | Animated great-circle arcs source-geo→target-geo over a dark globe (`renderType: arc`). The ethical-hacker analogue of the earthquakes layer. **Awareness/ambiance, not forensic attribution**, IP geolocation ≠ locating a person, and attackers proxy.               |
| **Query console / OSINT lookups**       | Shodan host data, CT logs, DNS, WHOIS, BGP origin, IP geolocation                                           | Input an **IP / domain / cert / ASN** → geolocate + enrich + plot. Grows out of the global search/fly-to subsystem. Passive, public sources only.                                                                                                                      |
| **Asset correlation ("triangulation")** | Multiple of the above at once                                                                               | One asset shown across Shodan + CT + BGP + GreyNoise simultaneously, the composite infrastructure picture. The analytically richest feature; the "triangulation" meant here is **multi-source asset correlation / infrastructure geolocation**, never locating people. |
| **Certificate Transparency firehose**   | CT logs                                                                                                     | Live public stream of every TLS cert issued, visualized by issuer/domain/geo. "The internet building itself in real time." Free.                                                                                                                                       |
| **BGP / routing events**                | RIPE RIS                                                                                                    | Live BGP updates; visualize route leaks/hijacks propagating. Advanced but distinctive. Free.                                                                                                                                                                           |
| **In-app terminal**                     | Drives the app + runs passive queries                                                                       | Command palette: `track UAL123`, `layer shodan on`, `goto 33.7,-116.3`, `query ip 8.8.8.8`, `correlate asn`, `preset surveillance`. **Constraint: commands the app and reads public indexes only, never touches remote hosts.** No scanning, no packets at targets.    |

_Cyber feeds (GreyNoise, AbuseIPDB, CT, RIPE RIS, honeypots) are named from knowledge and **not yet verified this session**, confirm terms at build time._

### 5.6 Additional layers from the original brief (fit where noted)

- **Radio stations**: Radio Browser API (free, no key). Events/points family.
- **Bikeshare**: GBFS feeds (free, no key). Movers/points family.
- **DOT / traffic cameras**: 511 / state DOT feeds. Distinct from and easier than the CCTV projection layer.

---

## 6. Mobile: S25 Ultra target (primary platform)

Device: Snapdragon 8 Elite, Adreno 830, 12GB RAM, 6.9" 120Hz LTPO panel, QHD+ 3120×1440 (ships defaulted to FHD+ 2340×1080). Desktop-class GPU silicon in a chassis that cannot dissipate desktop-class heat, this shapes nearly everything.

### 6.1 Rendering & resolution

- **`resolutionScale` set explicitly**, not following `devicePixelRatio` (which is ~3.5–4 at QHD+ → 4.5M px/frame → throttle in minutes). Target ~1.0–1.5 effective; upscaling is near-invisible at arm's length on a 6.9" panel.
- **Cap `targetFrameRate`**: 30 ambient, 60 cockpit. Don't let the 120Hz panel push 120fps for a globe that updates every 15s.
- **`requestRenderMode`**: render only on change. With static layers + still camera, frame cost drops near zero. Movers force continuous render, so this pairs with which layers are enabled.
- **Post-processing shaders (NVG/FLIR/CRT) are the danger zone**: full-screen fragment passes. Render post-process at a fraction of main resolution and upscale; treat multi-pass stacking as **desktop-only**. Biggest thermal risk on the phone.

### 6.2 Thermal & power

- **Thermal budget ladder** (auto-detected from rising frame-time trend, since Android exposes no thermal API to the web): full quality → drop post-processing → drop `resolutionScale` → drop to Cesium free terrain.
- **Wake Lock API** for cockpit mode only (never global).
- **Page Visibility API** to pause every poll loop and the AIS websocket when backgrounded, with explicit resume logic (Android suspends timers unpredictably).

### 6.3 Memory & WebGL context loss

- **Handle `webglcontextlost` / `webglcontextrestored` from day one.** **[verified]** Context loss is routine on Android (backgrounding, memory pressure, OS GPU reclaim): the #1 thing that makes Cesium apps feel broken on mobile. Don't rely on a full page reload.
- **Cap 3D-tile cache** (`maximumCacheOverflowBytes`, tileset `maximumMemoryUsage`): photorealistic tiles fill whatever you give them.
- **Entity discipline**: clustering + viewport culling are prerequisites; a dense AIS coastline or full GTFS agency = thousands of billboards.

### 6.4 Network

- **[verified] Mixed content:** on an HTTPS page, HTTP **scripts, stylesheets, iframes, fonts, and fetch/XHR (all your data feeds) are hard-blocked with no mobile override.** HTTP **images/audio/video** are silently auto-upgraded and dropped if no HTTPS exists. Chromium does **not** upgrade **bare-IP-host** or **local-network** URLs (some DOT/camera endpoints are bare-IP HTTP) → they just fail. **Everything routes through the HTTPS proxy.**
- **CORS**: many feeds send no headers → proxy handles it.
- **Cellular**: use the Network Information API (`effectiveType`, `saveData`) to default to Cesium free terrain on cellular; photorealistic is explicit opt-in with a warning. (Converges with the terrain decision: free is default, photorealistic is the toggle.)
- **Websockets**: AIS push behaves differently when the radio sleeps or the network hands off wifi↔cellular. Needs exponential-backoff reconnect + state resync on resume (missed messages, not just stale polls).

### 6.5 Touch & input

- **Pick tolerance**: fingertips are ~8–10mm; billboards are a few px. Use a drill-pick radius or oversize pickable geometry, or tap-to-track feels broken.
- **Tap vs drag disambiguation**: movement threshold + time window, or every imperfect tap becomes a camera orbit.
- **Gesture map**: one-finger drag orbits, two-finger pinch zooms, two-finger drag tilts (tilt is unintuitive on touch → give it a dedicated UI control).
- **S Pen**: `pointerType === 'pen'` + pressure. The right tool for the CCTV pose gizmo; consider pen-only affordances there.

### 6.6 Mobile-native capabilities (the phone's edge over the laptop)

- **Geolocation** → "around me" view: the phone's best UX. Fly to my position, show the surveillance/transit/flights around me. Same viewport/radius query the SDK already needs.
- **DeviceOrientation / compass** → point-at-sky AR-ish mode: hold the phone up, aircraft/satellites it points at light up, tap to track. Composes directly with the SGP4 satellite work.
- Both require HTTPS + explicit permission grant. Clean first-use permission flow, graceful degradation if denied, never block the globe on a denied permission.

### 6.7 Layout & shell

- Metadata card, layer toggles, presets → **bottom sheet** with snap points (thumb reach on a 6.9" panel).
- Fullscreen/immersive via Fullscreen API + `display: standalone` + `viewport-fit=cover` with safe-area insets.
- Support both orientations properly or lock one (half-supported landscape is worse than locked portrait).
- Service worker caches the app shell + Cesium static assets (large → real repeat-visit startup win), **not** live data.

---

## 7. Desktop: Linux (priority 2) & Windows (priority 3)

- Same Chromium engine, more thermal headroom, mouse/keyboard. If it runs well on the S25, it runs trivially here.
- **[verified] Linux gotcha:** Cesium sets `failIfMajorPerformanceCaveat: true` by default: it **hard-fails to initialize** (not slow-fallback) if it only gets software rendering. On Kali (b1t), if the GPU driver isn't providing hardware acceleration, the app won't start. **`chrome://gpu` on b1t is a pass/fail check, not a performance nicety.** The ROG Zephyrus G16's likely hybrid Intel+NVIDIA setup adds the "which GPU does the browser land on" question.
- Desktop enhancements (not required by core): hover states, right-click, keyboard shortcuts, full-quality cockpit + stacked shaders, photorealistic tiles by default on wifi.

### Dev / test workflow

- Remote debug the real phone over USB via `chrome://inspect` + adb, desktop device emulation tells you nothing about Adreno performance or thermals.
- Serving to the phone over LAN needs **HTTPS** (geolocation, orientation, service workers silently no-op over plain HTTP), set up a trusted local cert or tunnel early.
- Test **Samsung Internet** as well as Chrome, different version cadence, own quirks (media, storage quotas, PWA install); it's what many S25 users actually use.

---

## 8. Cross-cutting systems

- **Presets / scenes: first-class, core UX** (decided). "Everything on" is unusable mud and a phone-killer. Presets make omniscience navigable: **Around Me** (mobile launch default), **Sky** (flights/sats/launches/weather), **Surveillance** (the eyes cluster), **Disaster** (quakes/fires/dispatch/news), **Environment** (air quality/aurora/fires). On mobile these _are_ the primary navigation.
- **Default-on layers** (decided): flights + earthquakes + one transit feed: alive on load, cheap enough to survive the phone. Mobile "Around Me" overrides this at launch.
- **Global search / fly-to** (decided: in scope, staged mid-build): type a callsign/MMSI/satellite/place → camera flies + tracks. Per-layer search adapters; depends on a mature Layer SDK. Grows into the OSINT query console (Pillar 3).
- **Time dimension / scrubber** (decided: storage now, UI later): log every fix to a bounded **in-memory ring buffer** from day one even though nothing reads it in v1 (trails need recent history anyway). Keeps "live-only" honest (nothing persisted to disk; buffer evaporates on close) while leaving the door open to a rewind-the-last-N-hours scrubber without a painful retrofit.
- **Camera / cinematics:** click/tap-to-track + fading trail + metadata card is the **interaction spine** everything hangs on. Cockpit mode (camera rides a tracked entity, terrain-following). Sensor shaders (GLSL post-processing): desktop-favored, mobile-gated.
- **Interpolation / smoothing:** render ~1 polling interval behind real-time and interpolate between fixes: this is what makes 15–30s API updates look smooth.

### Additional feature ideas (general)

- **Proximity / geofence alerts**: notify when a tracked entity enters a region, or a new Shodan device appears in an area. Naturally mobile (notifications).
- **Multi-entity compare**: pin two aircraft/ships side by side with live stats.
- **Ambient / situation-room mode**: auto-rotating cinematic tour of active hotspots; good for a wall display.
- **Shodan facet analysis**: use Shodan's cheaper facet/summary endpoints to render aggregate density ("top exposed services by country") as heatmaps rather than individual hosts. More insight per credit; keeps it at population level.

---

## 9. Decisions log

### Locked

- Voice control **OUT**.
- Shodan device layer **IN** (visualization/awareness-only).
- Public CCTV layer **IN**.
- ALPR/plate-reading **OUT**; camera/reader _location_ mapping **IN**.
- OSINT/console pillar is **asset-focused and passive**; no people-targeting, no active/offensive tooling.
- Platforms: **S25 Ultra > Linux > Windows**, mobile-first.
- Architecture: **shared core, two shells, one repo** (not separate projects).
- Mobile shell **leans into being a phone** (geolocation "Around Me" as launch default; compass/sky mode as a staged fast-follow).
- **Terrain:** Cesium free terrain default; Google Photorealistic 3D Tiles an opt-in toggle (default off on mobile/cellular).
- **History:** ring-buffer now, scrubber UI later.
- **Presets:** first-class, core UX.
- **Default-on layers:** flights + earthquakes + one transit.
- **Global search/fly-to:** in scope, staged mid-build.
- **Layer interface:** handles rasters natively via `renderType`.
- **Mobile parity:** reduced-by-design (no heavy stacked shaders / full cockpit on phone): honest about thermals, leaning into what the phone is uniquely good at.
- Polish bar: **well-polished, each feature exceeding expectations.**
- "Around Me" defaults on at phone launch with graceful fallback to world view if denied.
- Compass/sky mode specced now, staged after "Around Me" ships.

### Deferred (raise when ready)

- **All club-specific concerns** (CODIS): deployment model (local-first per member vs shared deployment), shared state, attribution-as-teaching-feature. Parked until you bring them up. _(Default leaning if unspecified later: local-first per member: matches the reference, simplest key story, no shared-infra liability.)_
- Hosting / deployment plan (general).
- Overpass public-instance vs self-hosted (only if usage grows).

---

## 10. Build order (staged so each phase ships something visible)

1. **Bare Cesium globe + terrain** (free terrain baseline; capability-tier detection scaffolding).
2. **Proxy v1**: key broker + CORS + HTTPS terminator (needed before almost any real feed on mobile).
3. **Flights layer**: establishes the pipeline (poll→parse→render→interpolate) + OpenSky OAuth2 token manager in the proxy.
4. **Click/tap-to-track + trail + metadata card**: the interaction spine.
5. **Layer SDK**: formalize the interface (with `renderType`, viewport/radius fetch, clustering hooks) now that one layer proves the pattern. Layers become cheap after this.
6. **Satellites + earthquakes** (reuse the pattern; SGP4 + GMST for orbit rings).
7. **Presets + default-state + mobile shell v1** (bottom sheet, touch input, "Around Me" geolocation view).
8. **Cockpit mode.**
9. **Sensor shaders** (desktop-favored, mobile-gated).
10. **Ships (AIS via proxy websocket) + fires** (+ radio/bikeshare if time).
11. **Overpass integration**: landmarks + Flock/ALPR locations + public `man_made=surveillance` cameras off one Overpass client. _(Easier than CCTV, can be pulled earlier, e.g. right after step 6, for quick wins. Do not let CCTV block it.)_
12. **CCTV projection**: hardest visual feature (camera pose estimation).
13. **Shodan layer** (cached/snapshot queries; budget governor live).
14. **Compass / point-at-sky mode** (mobile fast-follow).
15. **Global search / fly-to** (needs mature SDK).
16. **Pillar 3: OSINT/cyber console:** threat-map arcs → query console → asset correlation → CT/BGP layers → terminal. Built on the search subsystem, once ambient layers are solid.
17. **Time scrubber UI** (the ring buffer's payoff).

---

## 11. Verification status (as of this session)

**Verified this session:** OpenSky (OAuth2, credit limits, viewport-bound); AISStream (no browser connections, ~300 msg/s, compression Sept 2026); NASA FIRMS (5,000/10-min, viewport-bound); mobile mixed-content blocking (feeds hard-blocked, bare-IP no-upgrade); Shodan (student free Membership, credit mechanics, cache-don't-live-search); Cesium `failIfMajorPerformanceCaveat` hard-fail on Linux; Cesium WebGL context loss on Android.

**Not yet verified: confirm at build time:** GreyNoise, AbuseIPDB, CISA KEV, CT logs, RIPE RIS/BGP, honeypot feeds; GTFS-RT agency specifics; USGS/GDELT/OpenAQ/PurpleAir/NOAA SWPC/GOES/Blitzortung/OpenCelliD/WiGLE/Tor consensus/Radio Browser/GBFS/DOT-511/DeFlock current terms.

**Standing rule:** treat this whole catalog as _candidates_. Feed availability, terms, and rate limits change constantly: verify each source's current terms at the moment you build its layer, not before.
