# Argus Audit (Phase A)

Baseline audit of the built app against `docs/master-plan.md`, the CVP integrations
catalog, and the known problems in `docs/audit-brief.md`. This is the truthful
inventory produced before any remediation. Nothing here is marked working unless it
was run and observed.

Status vocabulary:

- **Working**: verified by running; what was done and observed is stated.
- **Partial**: works in part; the failing part is stated.
- **Stub / fake**: renders but is not fed by its real source.
- **Broken**: present but errors or does nothing.
- **Missing**: not implemented.

This file is a running record, one section per pass (Phases A to E). File names
and defaults in an earlier phase describe the code at that time; the latest
phase that mentions an item is its current status. In particular, Phase E
replaced the old UI modules (`imagerySwitcher.js`, `layerToggles.js`,
`metadataCard.js`, `locateButton.js`, `presetBar.js`, `searchBox.js`,
`sensorControls.js`, `controlPanel.js`) with the ctOS components (the bar, the
LAYERS / VIEW / TOOLS menus, the target panel, the view stack's GEO cell), and
changed the default basemap on capable devices from Satellite to DARK.

---

## How this was verified

- Ran the unit suites: `node --test core shell-mobile` (108 pass) and
  `node --test proxy/test` (42 pass). All 150 green.
- Ran the Vite dev server and drove the app in a real browser (desktop shell,
  FULL tier, and mobile shell via `?shell=mobile` at a 375x812 viewport, BALANCED
  tier). Boot is clean, no console errors.
- Ran the proxy (`node proxy/server.js`) and exercised it directly with `curl`
  (relay, allowlist, health, governor) and through the app.
- Tested two data modes:
  - **Dev / no proxy** (default `npm run dev`): every layer is fed by its DEV
    mock. This is the state a plain `npm run dev` starts in.
  - **Dev + proxy** (set `VITE_PROXY_BASE_URL=http://localhost:8787`, proxy
    running): keyless feeds return real data; keyed feeds without secrets surface
    an honest error.

### The single most important framing: mock vs real

`main.js` wires every layer's source as `proxyClient ? proxy() : mock()`. So:

- With **no** `VITE_PROXY_BASE_URL`, the browser shows **mock data for every
  layer**. The globe looks fully populated (flights, ships, quakes, surveillance,
  etc.), but none of it is real. This is almost certainly what created the
  impression that the project was "done".
- With the proxy configured, layers switch to real feeds. Verified live:
  earthquakes rendered **192 real USGS events** clustered along real seismic zones
  (Aleutians, US west coast, Andes), while flights showed **`error 502`** in the
  readout because no OpenSky key is set. The readout surfacing that error honestly
  is good behavior.

There is no production fallback: a production build (`npm run build`) with no proxy
registers **no layers at all** (`setupScene` returns early), so the globe is bare
and every toggle is dead. This is the most likely cause of the owner's report that
"many switches do nothing" (see item 2).

---

## Known problems from the brief (verdicts)

### 1. Low-res globe, no street-level zoom -> FIXED (real terrain + imagery by default; photoreal wired)

**Remediation (Phase B):** the globe now defaults to **Satellite imagery + real 3D
terrain** on capable, non-metered devices. Terrain uses keyless Esri World
Elevation (`ArcGISTiledElevationTerrainProvider`), so real relief renders with no
secret. A **terrain toggle** (Flat / 3D Terrain / Photoreal) switches providers for
real; verified live by flying to the Grand Canyon and seeing genuine 3D relief under
satellite imagery. **Photoreal** (Google Photorealistic 3D Tiles) is wired through a
new proxy broker (`/tiles/google`, key server-side); without `GOOGLE_MAPS_API_KEY`
it degrades honestly (reverts to 3D Terrain, logs a clear reason) rather than
faking. The Google happy path is not verified (no key available). Metered / minimal
devices keep the flat + Relief baseline (cellular-friendly). Files:
`core/scene/terrain.js`, `core/scene/imagery.js`, `core/ui/imagerySwitcher.js`,
`proxy/lib/tiles.js`, `main.js`. Known minor artifact: a small dark patch at the
exact north pole where the elevation tileset has no coverage (cosmetic).

Original finding (kept for the record):

- **Zoom is not clamped.** No `minimumZoomDistance` / `maximumZoomDistance` is set
  anywhere. You can zoom all the way to the ground.
- **Street-level detail does work, via the imagery switcher.** Switching to
  **Streets** (OSM) over Manhattan rendered full street-level detail (named
  streets, Times Square, Bryant Park). Switching to **Satellite** (Esri World
  Imagery) rendered regional aerial imagery. Both tile services are reachable
  (verified 200 + correct content-type + CORS). `core/scene/imagery.js`.
- **What is actually wrong:**
  - The **default** basemap is Natural Earth II (`createBaseImageryLayer`), a
    coarse whole-world relief texture with no streets. Zooming into the default
    just magnifies a blurry texture, which reads as "the globe is low-res and I
    cannot zoom to streets." The fix is discoverability / a better default, not a
    new capability.
  - **Terrain is a flat ellipsoid only** (`core/scene/terrain.js` returns
    `new Cesium.EllipsoidTerrainProvider()`). No elevation, no Cesium world
    terrain, no 3D.
  - **Google Photorealistic 3D Tiles do not exist.** The master plan and README
    describe a free-vs-photorealistic terrain toggle; in code it is **comments
    only** (`terrain.js`, `capability/profile.js`). There is no `Cesium3DTileset`,
    no `createGooglePhotorealistic3DTileset`, no Google Maps key wiring, and no
    terrain toggle in any shell. The imagery switcher (Relief/Satellite/Streets)
    is a different control and does not switch terrain.
  - No Cesium Ion token is configured (by design: keys stay behind the proxy), so
    Ion-hosted world terrain / imagery are not available either.
- **Cause / files:** `core/scene/terrain.js` (flat only), `core/scene/imagery.js`
  (default is coarse), missing 3D-tiles module, no terrain toggle in
  `shell-desktop` / `shell-mobile` / `main.js`.

### 2. Many switches do nothing -> FIXED (all controls verified; dead paths closed)

**Remediation (Phase B):** every interactive control was exercised and works (layer
toggles, imagery, the new terrain toggle, presets, search, sensor shaders, terminal,
CT firehose ticker, and the time scrubber, which rewound to "-5:00" with the
scrubbing state active). The genuinely dead paths were closed: CCTV/Threats no
longer silently fail with a proxy set (item 3 mock fallback), the desktop "Around
Me" preset now actually flies (item 4), and a production build with no proxy shows
an explicit "No data source configured" notice instead of a bare, control-less
globe. Files: `main.js`.

Original finding (kept for the record):

- In the running app (both mock and proxy modes) **every layer toggle works**:
  enabling each of the 11 layers turned it green and produced live entity counts in
  the readout (Flights 40, Earthquakes 8, Fires 8, Ships 24, Surveillance 30,
  Landmarks 20, CCTV 5, Satellites 6, Threats, BGP). Imagery buttons, presets,
  sensor buttons, terminal, and search all responded.
- The dead-control scenario is real but conditional: a **production build with no
  `VITE_PROXY_BASE_URL`** registers no layers (`main.js` `setupScene` returns
  early when `!proxyBase && !dev`), so the toggle chips render but toggle nothing.
- **Cause / files:** `main.js:92-96` (early return), and the mock-only layers
  `cctv` / `threats` which are not registered at all outside dev
  (`main.js:337-340`), so those two chips are inert in any non-dev build.

### 3. Demo/simulation data instead of real data -> FIXED (real where possible; the rest labelled honestly)

**Remediation (Phase B):**

- **OSINT console made real.** The asset lookup / correlation console was 403ing
  against the real proxy because the ripestat client path repeated the feed's
  `/data` base (`/data/data/...`). Fixed both call sites (`core/osint/lookup.js`,
  `core/osint/correlate.js`) to be relative to the base. Verified live:
  `query 8.8.8.8` now returns real RIPEstat data (Prefix 8.8.8.0/24, ASN AS15169,
  Operator "GOOGLE - Google LLC", geo 37.75/-97.82) and plots it; network tab shows
  three 200s (maxmind-geo-lite, network-info, as-overview). Tests updated.
- **Honest demo labelling.** Layers with no verified real feed (CCTV, Threats) now
  carry a "demo" badge on their toggle chip and fall back to their mock even with a
  proxy set (previously a silent dead toggle in dev+proxy). When no proxy is
  configured at all, a "DEMO DATA" banner states that every layer is simulated.
  Verified both states in the browser. Files: `core/scene/layerManager.js`,
  `core/ui/layerToggles.js(.css)`, `main.js`, `styles.css`.

Real feeds are reached when `VITE_PROXY_BASE_URL` is set (and, for keyed feeds, when
the secret is present). The per-layer table below states which are real-capable.

### 4. "Around Me" is wonky -> FIXED

**Remediation (Phase B):** geolocation is now a shared one-shot helper
(`core/geo/geolocate.js`) used by both shells. "Around Me" flies to the device
location at a regional altitude (120 km, down from 200 km) so nearby flights and
quakes are framed, and it now works on **desktop** as well as mobile (the desktop
preset was previously a no-op). Denial / unavailability is handled gracefully (the
globe stays put) and reported to the UI. Verified: clicking triggers the request
and, when denied by the browser, degrades cleanly with no crash. Files:
`core/geo/geolocate.js`, `shell-mobile/index.js`, `shell-desktop/index.js`,
`main.js`.

Original finding (kept for the record):

- Geolocation lives **only in the mobile shell** (`shell-mobile/index.js`
  `aroundMe`). It calls `getCurrentPosition` and flies to the fix at
  **altitude 200 km**, which is a whole-region view, not "around me".
- On **denied / unavailable** it fails gracefully (stays at world view). Verified:
  in the mobile shell the app launched into Around Me, geolocation was unavailable
  in the test browser, and it degraded cleanly with no crash.
- On the **desktop shell there is no `aroundMe` at all** (by comment and by code).
  Clicking the "Around Me" preset on desktop only enables flights + quakes and
  never moves the camera, which is misleading.
- No user feedback on denial (silent). No radius control; nearby population relies
  on the layers' viewport-bounded fetch after the camera moves.
- **Cause / files:** `shell-mobile/index.js:41-55`, `shell-desktop/index.js`
  (no sensor code), `main.js:392,500,554-557`.

### 5. No "center on my location" button -> FIXED

**Remediation (Phase B):** added a "My location" button (`core/ui/locateButton.js`)
in both shells. It flies the camera to the device position at city level (12 km),
shows a pending state during the request, and on denial / unavailability shows a
brief error state with a clear title while leaving the camera put. The button is
pure UI; the shell owns the sensor read. Verified in the browser (denied path shows
"Location permission denied" and does not move the camera). Files:
`core/ui/locateButton.js(.css)`, `main.js`, both shells.

Original finding (kept for the record):

- There is no dedicated locate-me control in either shell. The only geolocation
  entry point is the "Around Me" preset, and only on mobile. Confirmed by search
  (`grep locate` finds nothing) and by inspecting both shells.

### 6. Arcs/lines/points look flat -> FIXED

**Remediation (Phase B):** the flat `point` renderer is now a glowing,
distance-scaled marker: a shared radial-glow sprite tinted per entity (bright core,
soft halo), shrinking and fading with distance for depth. This lifts all seven
point layers (earthquakes, fires, satellites, surveillance, landmarks, shodan, bgp)
into one coherent look, verified over real California terrain. Arcs and the tracked
trail already glowed and curved; they now also carry **depth-fail materials** so
they stay visible (dimmed) where they pass behind the new 3D terrain, and the arc
glow/width were nudged up. Verified: threat arcs render as glowing great-circle
paths with travelling pulses; point layers render as glowing orbs. Files:
`core/layers/sdk/renderers.js`, `core/interaction/tracker.js`. Still open: the
`raster` renderType remains unimplemented (weather / air-quality fields are new
layers, not geometry polish); documented as Missing below.

Original finding (kept for the record):

Per `core/layers/sdk/renderers.js` and each layer's `definition.js`:

- **Flat points (needs work):** earthquakes, fires, satellites, surveillance,
  landmarks, shodan, bgp all use `renderType: 'point'`, a plain `PointGraphics`
  dot with no glow and no distance scaling. This matches the "flat and basic"
  complaint.
- **Billboards (already distance-scaled):** flights, ships, cctv use
  `renderType: 'billboard'` with a `NearFarScalar`. Reasonable already.
- **Arcs (already decent):** threats use `renderType: 'arc'`: a bowed great-circle
  polyline with `PolylineGlowMaterialProperty` plus a travelling pulse point. Has
  glow and curvature; lacks an animated flowing gradient along the line.
- **Trails (already glowing):** the tracker draws a tapered
  `PolylineGlowMaterialProperty` trail plus a distance-scaled halo ring.
- **Gaps:** polylines use no depth-fail material (will clip through terrain once
  real terrain lands; currently moot on the flat ellipsoid). The `raster`
  renderType is declared but **throws** (`getRenderer` "not implemented yet"), so
  any field/heatmap overlay is unavailable.

---

## Scene, capability, and globe

| Feature                                 | Status                     | Evidence / notes                                                                                                                       |
| --------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Cesium viewer boot                      | Working                    | Boots clean on FULL (desktop) and BALANCED (mobile); no console errors. `core/scene/createViewer.js`.                                  |
| Capability tiering                      | Working                    | Readout shows tier + GPU + memory + cores + input + network; desktop FULL, mobile BALANCED, CRT hidden on mobile. `core/capability/*`. |
| requestRenderMode + tile-load pump      | Working                    | On-change rendering; readout shows `renderMode on-change`, `targetFrameRate 60 fps`, `resolutionScale 1`.                              |
| WebGL / software-render fatal guards    | Working (by code)          | `main.js` shows a fatal overlay for no-WebGL / software rendering; not triggerable on this HW.                                         |
| Context-loss handling                   | Working (by code + tested) | `core/scene/contextLoss.js`; not forced in-session.                                                                                    |
| Free terrain                            | Working                    | Flat `EllipsoidTerrainProvider`.                                                                                                       |
| Real elevation terrain                  | Missing                    | No world terrain provider.                                                                                                             |
| Google Photorealistic 3D Tiles + toggle | Missing                    | Comments only; no tileset, no key wiring, no toggle.                                                                                   |
| Base imagery (Relief)                   | Working                    | Local Natural Earth II, offline, coarse. Default.                                                                                      |
| Satellite imagery (Esri)                | Working                    | Real Esri World Imagery; verified rendering + reachability.                                                                            |
| Streets imagery (OSM)                   | Working                    | Real OSM tiles; verified street-level Manhattan detail.                                                                                |
| Imagery switcher UI                     | Working                    | Relief/Satellite/Streets swap the base layer live. `core/ui/imagerySwitcher.js`, `core/scene/imagery.js`.                              |

---

## Data layers and their real feeds

"Real path" = the proxy relay path is correct and the feed is reachable.
"Dev shows" = what a plain `npm run dev` renders.

| Layer        | renderType                | Real feed (proxy)                              | Real path status                                                                                    | Dev shows | Verdict                                 |
| ------------ | ------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------- | --------------------------------------- |
| Flights      | billboard                 | OpenSky `/states/all` (OAuth2, viewport-bound) | Path OK; needs `OPENSKY_CLIENT_*`. Live test returned honest `502` without keys.                    | mock      | Working (real) pending key; mock in dev |
| Earthquakes  | point                     | USGS `all_day.geojson` (keyless)               | **Verified real: 192 live events rendered.**                                                        | mock      | Working (real, verified)                |
| Satellites   | point (SGP4 `positionAt`) | CelesTrak `gp.php` TLE (keyless)               | Path OK; SGP4 + GMST implemented and unit-tested. Not runtime-confirmed with real TLE this session. | mock      | Working (real path); mock in dev        |
| Fires        | point                     | NASA FIRMS VIIRS (viewport-bound)              | Path OK; needs `FIRMS_MAP_KEY`.                                                                     | mock      | Working (real) pending key; mock in dev |
| Ships        | billboard                 | AISStream via `/ws/ais` (push)                 | Proxy consumer implemented + tested; needs `AISSTREAM_API_KEY` (warned unset).                      | mock      | Working (real) pending key; mock in dev |
| Surveillance | point                     | Overpass `man_made=surveillance` (keyless)     | Path OK (`/api/interpreter`). Not runtime-confirmed this session.                                   | mock      | Working (real path); mock in dev        |
| Landmarks    | point                     | Overpass tourism/historic (keyless)            | Path OK. Not runtime-confirmed this session.                                                        | mock      | Working (real path); mock in dev        |
| CCTV         | billboard                 | none (no generic real feed)                    | By design there is no real source; not registered outside dev.                                      | mock      | Stub by design (documented)             |
| Shodan       | point                     | Shodan `/host/count` facets (credit-free)      | Path OK; needs `SHODAN_API_KEY`; governor caps credits. Awareness-only, no search-on-pan.           | mock      | Working (real) pending key; mock in dev |
| Threats      | arc                       | none (GreyNoise/honeypots unverified/keyed)    | By design no real source yet; not registered outside dev.                                           | mock      | Stub by design (documented)             |
| BGP          | point                     | RIPE RIS Live via `/ws/bgp` (keyless)          | Proxy consumer implemented + tested; keyless so real-capable. Not runtime-confirmed this session.   | mock      | Working (real path); mock in dev        |

Master-plan layers that are **Missing** entirely: weather and air-quality raster
fields (the `raster` renderType throws), a transit feed (`DEFAULT_LAYERS` comment
notes "one transit, N/A yet"), radio, and bikeshare.

---

## UI controls and interaction

| Control                         | Status                    | Evidence                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer toggles (11)              | Working                   | All toggled on with live counts; visual state tracks real state. In a bare prod build they would be inert (see item 2). `core/ui/layerToggles.js`.                                                                                                                                                                                                      |
| Presets (5)                     | Partial                   | Around Me / Sky / Disaster / Environment / Surveillance apply their layer sets. "Around Me" on **desktop** does not geolocate (no-op camera). `core/presets.js`.                                                                                                                                                                                        |
| Global search + geocoder fly-to | Working                   | Typed "Tokyo" -> combined entity + place results -> selecting "Tokyo, Japan" flew the camera there. Real geocoder path (Nominatim) is correct. (Re-checked: threat entities matching "Tokyo" are Tokyo-related by target/source city, so the match is relevant; only the result label, which shows the threat category, obscures why.) `core/search/*`. |
| Metadata card                   | Working                   | Clicking a quake showed M 7.4 with magnitude/depth/time/coordinates. `core/ui/metadataCard.js`.                                                                                                                                                                                                                                                         |
| Click / tap to track            | Working                   | Selected entity `mq6`; camera followed. `core/interaction/picker.js`, `tracker.js`.                                                                                                                                                                                                                                                                     |
| Trails                          | Working                   | Glowing tapered polyline + halo ring on the tracked entity. `tracker.js`.                                                                                                                                                                                                                                                                               |
| Sensor shaders (NVG/FLIR/CRT)   | Working                   | NVG verified (full green night-vision with vignette/noise). CRT is full-tier only and hidden on mobile. `core/shaders/sensorShaders.js`.                                                                                                                                                                                                                |
| In-app terminal                 | Working                   | `help`, `layers` (listed all layers `[on]`), and `query` all ran. `core/ui/terminal.js`, `core/osint/terminal/commands.js`.                                                                                                                                                                                                                             |
| Capability readout              | Working                   | Live tier/GPU/counts panel. `core/ui/capabilityReadout.js`.                                                                                                                                                                                                                                                                                             |
| CT firehose ticker              | Partial                   | UI + toggle implemented; connects `/ws/ct` on toggle. Public CertStream upstream is often silent and needs `CT_STREAM_URL`; dev uses a synthetic stream. Real data not confirmed. `core/ui/ctTicker.js`, `core/osint/ct/*`.                                                                                                                             |
| Time scrubber                   | Working (by code + tests) | Clock + ring-buffer history + UI wired; movers rewind against the shared clock. Rewind not drag-tested this session. `core/ui/timeScrubber.js`, `core/scene/clock.js`, `core/layers/sdk/ringBuffer.js`.                                                                                                                                                 |
| Cockpit mode                    | Working (by code)         | Offered for movers when tier is not minimal; not runtime-ridden this session. `core/interaction/cockpit.js`.                                                                                                                                                                                                                                            |
| Compass / point-at-sky          | Working (by code + tests) | Mobile-only "Point at sky" button present; DeviceOrientation math unit-tested. Not sensor-tested in-browser. `shell-mobile/compass.js`, `orientation.js`.                                                                                                                                                                                               |
| Around Me (geolocation)         | Partial                   | See known problem 4.                                                                                                                                                                                                                                                                                                                                    |
| Locate-me button                | Missing                   | See known problem 5.                                                                                                                                                                                                                                                                                                                                    |

---

## Proxy (the six jobs)

Verified live: proxy boots, listens on :8787, `/health` reports per-feed config and
governor budget. Relayed **real** USGS data (HTTP 200, ~137 KB GeoJSON). Emitted
honest warnings that OpenSky and AISStream keys are unset. Feed allowlist enforced
(an off-allowlist path returns 403). 42 proxy unit tests pass.

| Job                                | Status                                                   | Evidence                                                                        |
| ---------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1. Key/secret broker               | Working                                                  | `feeds.js` inject rules; secrets server-side only.                              |
| 2. OAuth2 token manager (OpenSky)  | Working (by code + tests); not exercised with real creds | `proxy/lib/oauth.js`; without creds the feed returns 502 as designed.           |
| 3. CORS shim                       | Working                                                  | `proxy/lib/cors.js`; browser reached the proxy cross-origin; preflight handled. |
| 4. HTTPS terminator                | Working (by code)                                        | `npm run start:https` / self-signed; not run in HTTPS this session.             |
| 5. Stateful AIS websocket consumer | Working (by code + tests)                                | `proxy/lib/ais.js`, `/ws/ais`; needs `AISSTREAM_API_KEY`.                       |
| 6. Rate / budget governor          | Working                                                  | `proxy/lib/governor.js`; `/health` shows ripestat budget usage incrementing.    |
| Extra: BGP RIS Live `/ws/bgp`      | Broken, fixed in Phase C                                 | Never connected beside `/ws/ais` (ws path mismatch answered 400). See Phase C.  |
| Extra: CT CertStream `/ws/ct`      | Partial; routing fixed in Phase C                        | Same 400 bug as BGP; upstream often silent, needs `CT_STREAM_URL`.              |
| Feed allowlist (anti-SSRF)         | Working                                                  | Off-allowlist path -> 403 "path not in feed allowlist".                         |

Fixed (Phase B): `/health` now reports `configured` truthfully for every feed, not
just OAuth ones: a feed with a required injected secret reads `configured: false`
until that secret is set (verified live: firms/shodan report false without keys;
keyless feeds stay true). `proxy/lib/app.js` + a proxy test.

---

## OSINT / CVP console

CLAUDE.md guardrails keep most of the CVP catalog **permanently out of scope**
(active scanning, exploit/payload development, ALPR, people-targeting). None of
those are implemented, which is correct. What is built is the **passive**
Category D/F console.

| Piece                             | Status                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset classifier (guardrail gate) | Working                              | `query jane smith` -> "not a valid asset (expected ip/domain/asn)"; only IP/ASN/domain accepted. `core/osint/asset.js`. This is the enforced scope gate, and it holds.                                                                                                                                                                                                                                                                    |
| Asset lookup / enrichment         | **Broken (against real proxy)**      | `query 8.8.8.8` returned "lookup unavailable or no location". Root cause: `core/osint/lookup.js` requests subpath `/data/<call>/data.json`, but the ripestat feed `baseUrl` already ends in `/data`, so the upstream path doubles to `/data/data/...` and the allowlist rejects it with **403**. Verified: the correct path returns real geo for 8.8.8.8 (lat 37.751, lon -97.822); the client path returns 403. Works only in mock mode. |
| Asset correlation                 | **Broken (against real proxy)**      | Same root cause: `core/osint/correlate.js:47` uses the same `/data/<call>/data.json` pattern -> 403. Mock-only.                                                                                                                                                                                                                                                                                                                           |
| OSINT plotter                     | Working (by code); depends on lookup | Plots query outputs and resolves them via the interaction spine (`main.js` extra resolver). Real plotting is blocked by the lookup 403 above. `core/osint/plotter.js`.                                                                                                                                                                                                                                                                    |
| Threat-map arcs                   | Stub by design                       | Glowing great-circle arcs with pulses; fed by a synthetic ambient stream only (no verified real source).                                                                                                                                                                                                                                                                                                                                  |
| Shodan awareness                  | Working (real path) pending key      | Credit-free `/host/count` facets only; governor enforces budget. Awareness-only per guardrails.                                                                                                                                                                                                                                                                                                                                           |
| CT / BGP                          | see proxy section                    | CT partial (silent upstream); BGP real-capable (keyless).                                                                                                                                                                                                                                                                                                                                                                                 |
| Terminal command surface          | Working                              | `layers`, `query`, `correlate`, `goto`, `track`, `applyPreset`, `geocode` wired; passive-only. `core/osint/terminal/commands.js`.                                                                                                                                                                                                                                                                                                         |

---

## Guardrail verification (required by the brief)

- **People-targeting refused:** the asset gate rejects a name at runtime (verified).
  Inputs are assets (IP/ASN/domain) only.
- **No active/offensive tooling:** no port scanning, nmap, exploit frameworks, or
  packet-sending code anywhere. The terminal and console run passive index reads
  only.
- **No ALPR / camera-vision:** CCTV is location + pose only; no feed-reading vision.
- **No voice control.**
- **Secrets stay server-side:** every real feed routes through the proxy; no
  `VITE_`-prefixed secret; client env is non-secret config only.
- **Anti-SSRF:** the proxy can only reach feeds on its allowlist (off-list -> 403).

Guardrails are intact. The one caveat is that the passive lookup being broken means
the scope gate has not been exercised end-to-end against the real upstream (it is
exercised at the classifier, which is the gate that matters).

---

## Prioritized remediation plan (Phase B)

Worst-first, matching the brief's ordering.

1. **Terrain / imagery / street-level (item 1).**
   - Make the app usable at street level by default: either default to Satellite,
     or make the switcher obvious, or both.
   - Add real terrain (Cesium world terrain via the proxy-brokered Ion token) and
     wire an actual **free-vs-photorealistic terrain toggle** (Google Photorealistic
     3D Tiles behind the proxy key), off by default on mobile/cellular. Today this
     is entirely missing.
2. **Real data for every layer (item 3).**
   - Provide a proxy base + keys and confirm each layer live in the network tab.
   - Fix the **ripestat path-doubling 403** so asset lookup / correlation work
     against the real proxy (they are the CVP console's core and are currently
     mock-only).
   - Decide and clearly label the genuinely sourceless layers (CCTV real feed,
     Threats real feed) as demo in the UI, not just in comments.
3. **Dead controls (item 2).**
   - Ensure a production build without a proxy either registers layers against a
     configured proxy or clearly disables/labels the inert chips (CCTV, Threats
     outside dev; all layers in a proxy-less prod build).
4. **Geolocation (items 4, 5).**
   - Add a locate-me button (both shells). Bring Around Me to desktop. Lower the
     Around Me altitude to a sensible framing and add denial feedback.
5. **Visual polish (item 6).**
   - Upgrade flat `point` layers to glowing, distance-scaled markers. Add flowing
     gradients to arcs. Add depth-fail materials to polylines (before real terrain
     lands). Implement the `raster` renderType if weather/air-quality are wanted.
6. **Everything else flagged above**, worst-first: CT upstream reliability, the
   `/health` truthfulness for keyed feeds, and search relevance (threat entities
   matching place-name queries).

---

## Reproducing the real-data checks

```bash
# terminal 1: proxy
cd proxy && npm install && node ../proxy/server.js   # or: npm start

# terminal 2: point the client at it, then run the dev server
echo "VITE_PROXY_BASE_URL=http://localhost:8787" > .env   # .env is gitignored
npm run dev
```

Keyless feeds (earthquakes, satellites, overpass surveillance/landmarks,
nominatim, BGP) return real data immediately. Keyed feeds (flights, fires, ships,
shodan) need their secrets in the proxy environment; without them the layer shows
an honest error rather than mock data.

---

## Phase B remediation summary

What was **fake and is now real**:

- Earthquakes verified rendering real USGS events; the OSINT asset console
  (query/correlate) now returns real RIPEstat data and plots it (was 403 against
  the proxy, mock-only before).
- The globe itself: real Satellite imagery + real keyless 3D terrain by default,
  instead of a coarse offline basemap on a flat ellipsoid.
- Data that is still simulated is now clearly marked: CCTV/Threats carry a "demo"
  badge, and a "DEMO DATA" banner shows when no proxy is configured. Nothing mock
  is presented as real.

What was **broken and is now fixed**:

- Street-level view: real terrain + a working Flat/3D/Photoreal terrain toggle;
  Satellite/Streets imagery gives street-level detail.
- OSINT lookup/correlation path-doubling 403.
- Dead controls: CCTV/Threats no longer silently fail with a proxy; the desktop
  "Around Me" preset now flies; a proxy-less production build shows a clear notice.
- Geolocation: "Around Me" works on desktop too and is framed sensibly; a new "My
  location" button flies to the device position with graceful denial handling.
- Flat point markers upgraded to glowing, distance-scaled markers; arcs and trails
  gained depth-fail materials for the new 3D terrain.
- `/health` now reports keyed-feed configuration truthfully.

What **remains genuinely incomplete** (and why):

- **Keyed live feeds** (OpenSky flights, FIRMS fires, AISStream ships, Shodan):
  the real path is wired and correct, but not verified end-to-end because no API
  keys were available in this environment. Each shows an honest error (or demo
  fallback) until its secret is set on the proxy.
- **Photorealistic 3D Tiles**: fully wired through the proxy broker, but the Google
  happy path is unverified because no `GOOGLE_MAPS_API_KEY` was available. Degrades
  honestly without one.
- **CT firehose real data**: the ticker and socket work (verified with the mock
  stream), but the public CertStream upstream is often silent; real issuance data
  needs a working aggregator via `CT_STREAM_URL`.
- **`raster` renderType** (weather / air-quality fields): still unimplemented. This
  is a new layer type and feed, not geometry polish, so it stayed out of this pass.
- **Compass / point-at-sky and cockpit**: implemented and unit-tested, but not
  exercised with real device orientation in this desktop browser.
- **Minor**: a small dark patch at the exact north pole (elevation tileset has no
  coverage there); and the keyless Esri tile services can transiently 502 under
  heavy rapid loads (proxy-side tile caching would harden this for production).

---

## Phase C: finishing for personal use (phone, PC, Kali, terminal)

Goal of this pass: make the project usable day to day on all three targets and
add the requested dedicated terminal version, then fix whatever stood in the
way. Same honesty rule as before: "verified" below means run and observed.

### Environment limits of this pass (read first)

- **The npm registry was blocked** by the build environment's network policy,
  so Cesium, Vite, `satellite.js`, and `ws` could not be installed. The web app
  was therefore **not built or run in a browser in this pass**. Its changes are
  lint-clean and unit-tested where pure, but browser behaviour is unverified.
- **Outbound access to every data host was blocked** (USGS, adsb.lol, CelesTrak,
  RIPEstat, Overpass, jsDelivr, RIS Live). Live feed paths were exercised only
  through tests with fixtures and through demo data. adsb.lol's current terms
  and endpoint could not be re-checked (see SETUP.md).
- `ws` was exercised with the copy bundled inside Playwright, by mapping the
  import in a scratch loader (not shipped).

### Broken before, fixed now

| #   | Problem                                                                                                          | Cause                                                                                                                        | Fix / evidence                                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `/ws/bgp` and `/ws/ct` never connected through the real proxy (BGP layer and CT ticker dead with a proxy)        | Three `WebSocketServer({ server, path })` on one HTTP server; ws v8 answers **400** to any path but the first-attached one   | Single upgrade router + `noServer` servers (`proxy/lib/wsRoutes.js`). Reproduced the 400 with a real ws server; the new regression test fails on the old code, passes now                                |
| 2   | Keys in `.env` were ignored by the proxy, although SETUP.md said to put them there                               | Nothing loaded `.env`                                                                                                        | `proxy/lib/env.js` (repo `.env`, `proxy/.env`, `~/.config/argus/.env`; real env wins). Tested                                                                                                            |
| 3   | `npm test` failed on Node 22 (the audit's 108 passes were from an older Node)                                    | `node --test core` runs `core/index.js` as a module on Node 22 (imports Cesium + CSS)                                        | `scripts/run-tests.js` lists test files explicitly; works on Node 20 and 22. Verified on Node 22                                                                                                         |
| 4   | A production build only worked with `VITE_PROXY_BASE_URL` baked in; the phone over LAN could not reach the proxy | The app only knew an absolute proxy URL; `https://phone-page` -> `http://localhost:8787` is the wrong host and mixed content | The proxy serves the built app (`npm start`), the dev server forwards proxy routes, and the app discovers a proxy at its own origin. Proxy side verified with curl; browser side unverified (see limits) |
| 5   | Default-on flights showed `error 502` with no OpenSky key                                                        | OpenSky is the only flights source                                                                                           | Keyless adsb.lol fallback chosen from `/health`; parser + point query unit-tested. Live endpoint unverified                                                                                              |
| 6   | Layer errors showed only a status code                                                                           | The proxy client discarded the proxy's JSON reason                                                                           | Errors carry the reason (e.g. which key is missing); shown on hover in the readout and in the terminal shell. Tested                                                                                     |
| 7   | Phone re-prompted for the certificate on every proxy restart                                                     | A new self-signed cert per start, with no LAN IP in it                                                                       | Generated once (with LAN IPs) and kept in `~/.config/argus/tls`; mkcert path documented for a trusted cert                                                                                               |
| 8   | CLAUDE.md mobile requirements missing: thermal ladder, 3D-tile cache caps, PWA manifest + service worker         | Never built                                                                                                                  | `core/capability/thermalLadder.js` (+ scene binding), per-tier `tileCacheSize` and tileset byte caps, `public/manifest.webmanifest`, `public/sw.js`, generated icons                                     |

### New

- **Terminal shell** (`shell-terminal/`, `argus tui`): braille world map with
  coastlines (built-in coarse outline offline, Natural Earth when fetched and
  cached), graticule, place names, all nine real layers as glyphs, selection,
  tracking with trails and orbits, metadata cards, presets, the shared command
  language, CT ticker, passive OSINT plotting, JSON export, mouse support. It is
  built from core's own parsers, normalizers, formatters, push clients, and
  mocks (pure helpers were moved out of the Cesium definitions so every shell
  shares them). Embedded loopback proxy, `--proxy URL`, or `--demo`.
- **Scriptable CLI**: `argus query|correlate|quakes|flights|sats|fires|geocode|bgp|ct|health`, text or `--json`.
- **Launcher + installer**: `bin/argus.js` (`web`, `proxy`, `tui`, CLI) and
  `scripts/install-linux.sh` (command on PATH, keys file, menu launchers, GPU check).

### Independent review of this pass (fixed)

A separate review of the whole Phase C diff, which reproduced each issue with
scratch scripts, found these; all are fixed with regression tests that fail on
the earlier code:

- Terminal: on a terminal smaller than 40x12 every frame was treated as a resize
  (flicker, and viewport feeds refetched about once a second).
- Terminal: while tracking, viewport feeds and the AIS subscription box never
  followed the tracked entity (drift was measured frame to frame).
- Terminal: coastlines of world-spanning rings (Eurasia, Antarctica) vanished
  when zoomed in east of their first point (wrapped copies were skipped).
- Terminal: a fast layer toggle could subscribe a push stream twice and leak a
  socket and a timer (start/stop race); same for the CT ticker.
- Thermal ladder: recovery could cycle forever on a device that reheats
  (frame intervals are capped, so headroom is invisible); it now backs off. Idle
  gaps now reset the evidence, the budget follows cockpit mode's 60 fps cap, and
  a rung that does nothing on the device (post-processing without shaders) is
  skipped.
- `.env`: a quoted value followed by a comment kept its quotes.
- Dev forwarding ignored the proxy's `PROXY_PORT` / `PROXY_HTTPS`.
- Service worker caches are now versioned per build, so a Cesium upgrade cannot
  mix old and new code on the first load.
- The terminal is restored on an external SIGINT; `argus ... | head` exits quietly.

### Verified in this pass

- Unit tests: `npm test` passes everything except the 2 suites that need
  `satellite.js` / `cesium`, which could not be installed here. Proxy: 54 of 54
  pass when run with a `ws` implementation (Playwright's bundled copy).
- Proxy run with `--static`: `/health`, app files with correct types and cache
  headers, traversal attempts refused (404), unknown feeds refused.
- Terminal shell: rendered headless on demo data at several sizes and zooms, and
  driven inside a real pseudo-terminal (`script`): keys, command line, `goto`,
  selection and tracking, quit restoring the terminal (exit code 0).
- CLI: `health`, `query`/`correlate`/`geocode` on demo data, refusal of a
  person's name (`query "jane smith"` exits 2: assets only), usage errors.
- Installer: run against a scratch `HOME`; the symlinked `argus` resolves the repo.
- Service worker routing: run in a VM sandbox; feeds, websockets, `/health`,
  brokered tiles, and third-party tiles are never intercepted.
- PWA icons: generated and inspected.

### Still unverified or incomplete (and why)

- **Web app in a browser** (all Phase C client changes): blocked by the registry
  limit above. First thing to check on a real machine: `npm install && npm start`,
  then the globe, the network tab (requests go to the page's own origin), and a
  flights layer with no OpenSky key (adsb.lol).
- **Live data end to end** from the terminal shell and CLI: blocked by the egress
  limit above.
- **Thermal ladder on a real phone**: logic tested with synthetic frame-time
  sequences; thresholds may need tuning on the S25.
- **PWA install**: needs trusted HTTPS on the phone (SETUP.md, mkcert).
- Unchanged from Phase B: keyed feeds without keys here, photoreal tiles,
  CertStream upstream silence, `raster` renderType, CCTV/threats demo-only.

## Phase D: parity with the reference project, Android standalone

Goal of this pass: compare Argus with the reference project
(`bilawalsidhu/gods-eye-view`), port what was missing and fits the guardrails,
make Android work without a PC, and merge to `main`. The full feature-by-feature
comparison, including what was left out on purpose and why, is in
[COMPARISON.md](COMPARISON.md).

### Environment limits of this pass (read first)

Same as Phase C: the npm registry answered 403 and every data host was blocked,
so the web app was **not built or run in a browser**, and **no new upstream was
reached live**. Endpoints, parameters and field names for the ported layers come
from the reference project's working source; they are marked "per the reference
implementation, not live-tested here" in `proxy/feeds.js`. Globe-side code was
exercised against a Cesium stub (a scratch loader, not shipped).

### Broken before, fixed now

| #   | Problem                                                                           | Cause                                                                                                            | Fix / evidence                                                                                                                          |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Surveillance and landmarks stayed empty on the globe with a live proxy            | `mode: 'viewport'` layers never received a bounding box (only `viewportBounded` polls did); the dev mocks hid it | `createLayer` always bounds viewport-mode queries. Stub harness shows the bbox now reaches the source                                   |
| 2   | Turning off one moving layer froze the others (e.g. flights off while ships move) | Each mover saved and restored `requestRenderMode` on its own                                                     | Reference-counted per scene. Stub harness: two movers on, one off, still continuous; both off, on-demand again                          |
| 3   | OSM layers and CelesTrak bulk groups likely refused by public servers             | Requests carried Node's default User-Agent (the reference project hit 406s from Overpass)                        | Every feed sends a descriptive User-Agent with a contact URL; `OVERPASS_URL` points Overpass elsewhere                                  |
| 4   | An Overpass timeout was cached as "nothing here" for 10 minutes                   | Overpass reports runtime errors as HTTP 200 with a `remark`                                                      | Treated as an error and never cached. Tested                                                                                            |
| 5   | `argus web` crashed in Termux                                                     | `os.networkInterfaces()` throws EACCES under Android's sandbox                                                   | Tolerated (no LAN list on Android). Tested                                                                                              |
| 6   | Keyless flights used `/v2/point/...`, a path the reference does not use           | Guessed from docs at build time                                                                                  | Switched to the reference's live-used `/v2/lat/../lon/../dist/..`, anchor snapped to 0.25 degrees so pans share the proxy cache. Tested |

### New

- **Layers** (each config against the Layer SDK; pure parse/format shared by the
  globe and the terminal; demo sources; tests): military air, my receiver
  (`LOCAL_ADSB_URL`), navigation and GEO satellites, launches, transit (7
  GTFS-RT operators, default-on), bikeshare (16 GBFS systems), cyclones, IR
  clouds, US radar, lightning density, traffic cameras (Caltrans, TfL, Statens
  vegvesen), radio, data centres, installations, submarine cables (cable landing
  points in the terminal).
- **SDK**: `raster` render type (imagery overlays through the same interface),
  `polyline` render type, `positionCacheMs` for large compute-position sets,
  `statusNote` (why a layer is empty) shown in the readout and the terminal.
- **Proxy**: response cache with stale-on-error for rate-limited feeds;
  `baseUrlEnv` overrides; `localOnly` feeds that refuse any non-LAN upstream;
  image-only feeds pinned to official camera hosts; `getBytes` in the client for
  protobuf.
- **UI**: grouped layer toggles, cards with source links and images, north-up /
  tilt / whole-Earth buttons, an Internet preset; transit joins the default-on set.
- **Terminal**: the new layers, tap or click a side-panel row to toggle, a
  compact list when space is short; `argus military | storms | launches`.
- **Android**: `scripts/install-termux.sh` runs the proxy, the globe (Chrome on
  `http://localhost:8787`, a secure context) and the terminal on the phone itself.

### Verified in this pass

- `npm test`: 243 pass; the 2 failing suites need `satellite.js` / `cesium`,
  which could not be installed. Proxy: 68 of 68 with Playwright's bundled `ws`.
- ESLint with a scratch approximation of the repo's config (the core recommended
  rules; `@eslint/js` could not be installed) and Prettier: clean.
- Every new globe layer run through the real `createLayer` against a Cesium
  stub with its demo source: entity counts, cards, links, viewport bbox, mover
  reference counting, the raster spec reaching an imagery layer.
- Every `import()` path and export name in `main.js` resolved (except modules
  needing `satellite.js`, and CSS imports that only Vite handles).
- Terminal: every new layer on demo data in tests; frames rendered headless.
- Proxy allowlists: each GTFS-RT, GBFS, camera and catalogue path resolves and
  is allowed; neighbouring paths on the same hosts are refused. Tested.

### Independent review of this pass (fixed)

Two reviewers (proxy and security; layers, SDK and terminal) read the diff and
reproduced their findings; each fix below has a test or a stub-harness check.

| Finding                                                                                                                                   | Fix                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Cache poisoning: a client asking LL2 for `text/html` made every later JSON client get the HTML page                                       | The cache key includes `Accept`                                                                                |
| Concurrent requests all passed the rate/credit governor before any was counted (20 of 20 got through)                                     | `governor.acquire()` counts at check time; a request the upstream never answered is refunded                   |
| Overpass allowlist unanchored (`/kill_my_queries/api/interpreter` passed)                                                                 | Anchored; an `OVERPASS_URL` override is judged against the default base path                                   |
| nowCOAST's generic `ows` endpoint let any OGC operation through, unmetered                                                                | Query pinned to tile-sized WMS GetMap of the three layers; rate cap                                            |
| `localOnly` feed followed redirects off the device; link-local accepted; `/health` said "ready" for a bad URL                             | No redirects for local feeds; link-local dropped; `/health` uses the relay's own validation                    |
| Upstream names could carry terminal escape sequences (station names are user-submitted)                                                   | Control characters drawn as `?` in the TUI and escaped in CLI output                                           |
| Termux bound the keyed proxy to every interface on a phone that may be on public Wi-Fi                                                    | Loopback by default on Android; `--host 0.0.0.0` to share                                                      |
| A double-tapped preset built a second copy of a layer that kept polling (and rendering) forever                                           | One in-flight load per layer; the latest on/off request wins                                                   |
| Sensor shaders and moving layers each saved and restored the render mode, freezing one or leaving the scene rendering at idle             | One shared claim count (`core/scene/renderMode.js`)                                                            |
| Tapping a military aircraft also shown by Flights opened the Flights card (ids are per layer)                                             | The resolver matches the picked entity itself                                                                  |
| City layers (traffic cams, bikeshare, transit) only refetched on their timer after the camera moved                                       | Bounded layers refetch when the camera settles (at most every 5 s, so panning cannot multiply metered queries) |
| Transit animated every vehicle of a network (all of the Netherlands for a view of Amsterdam)                                              | Transit, bikeshare and camera sources keep only what is in and around the view                                 |
| An aborted poll could ingest partial multi-feed data; viewport layers went on a timer after a tab switch                                  | Aborted polls are discarded; viewport layers never get a timer                                                 |
| Weather refresh blanked the overlay and reordered clouds and radar                                                                        | The new frame takes the old one's slot; the old one goes once tiles have loaded                                |
| Mobile start highlighted Around Me without its full layer set                                                                             | Mobile applies the Around Me preset itself                                                                     |
| A civil aircraft wrongly flagged military would show its registered owner                                                                 | The operator is shown only when it reads as a state body                                                       |
| Flights centred on longitude 0 for a view across the antimeridian                                                                         | The view keeps its true edges for point queries                                                                |
| Smaller: Overpass client cache unbounded, right-click toggled layers, Termux swapped an installed `nodejs`, zoom hints over dev mock data | Capped at 40 regions; left button only; install only what is missing; hint only when nothing loaded            |

Left as is: NHC's `movementSpeed` unit (shown as knots, as the reference reads
it; listed below to check live), and the CLI embeds a fresh proxy (so a fresh
governor) per run, which upstream rate limits still bound.

### Still unverified or incomplete (and why)

- **Every new upstream, live** (egress blocked). Specific assumptions to check
  first: `all.api.radio-browser.info` serves the search API (else set
  `RADIO_BROWSER_URL`); nowCOAST ignores the `_` refresh parameter; LL2
  `mode=normal` includes pad coordinates; NHC `movementSpeed` is in knots (as
  the reference reads it).
- **Web UI in a browser**: card images, grouped toggles, raster overlays,
  cable polylines at 300 m, the view buttons.
- **Nav & GEO sats** on the globe: needs `satellite.js` (not installable here).
- **Termux installer** on a real phone (checked for syntax and its refusal off
  Termux only).
- Deferred features are listed in [COMPARISON.md](COMPARISON.md).

## Phase E: ctOS interface, faster renderer, the rest of the reference

Goal of this pass: move the whole UI onto the ctOS design system the owner
supplied (`design/ctos`), make the globe cheaper to draw, give aircraft real
silhouettes (and 3D models up close), fix selection (a click used to zoom the
camera in with no card), add blob-tracking chrome and map labels, and port the
reference project's remaining features that fit the guardrails. Commits after
`52cd673` up to `e3f138b`. The comparison with the reference, including what was left out and
why, is in [COMPARISON.md](COMPARISON.md).

### Environment limits of this pass (read first)

- **No network at all.** The npm registry and every data host were blocked by
  policy, so Cesium, Vite, `satellite.js` and `ws` could not be installed and no
  upstream was reached. **Nothing in this pass ran against real Cesium, a GPU,
  a real phone, or a live feed.**
- Every new upstream is marked "per the reference implementation, not
  live-tested here" in `proxy/feeds.js` and `proxy/feeds/*.js`. Endpoints,
  parameters and field names come from the reference project's working source.
- The UI was checked in a scratch preview harness (not shipped): the real
  shells and components on a stub Cesium in headless Chromium, with
  screenshots. That checks layout, styling and DOM behaviour only. Which states
  were captured was not recorded item by item, so read "Stub-checked" below as a
  layout check, not as proof that an interaction works on a real globe.
- Performance work is by design and code reading. No frame time, GPU load or
  thermal behaviour was measured on any hardware.

Status words added for this pass:

- **Stub-checked**: rendered in the stub harness and screenshotted (see above).
- **Not live-tested**: the code path is unit-tested with fixtures, but its
  upstream was never reached.

### Broken before, fixed now

| #   | Problem                                                                                         | Cause                                                                                                        | Fix / evidence                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Clicking a contact zoomed the camera in and no card appeared (owner report)                     | Selecting handed the camera to Cesium's `trackedEntity`, which flies in to the entity; the card was not seen | Selecting never moves the camera: it sets the target, trail and hub lock and opens the target panel. FOLLOW is explicit and keeps the current distance. `core/interaction/tracker.js`. Stub-checked |
| 2   | Every contact was a Cesium Entity (property objects and visualizer work per contact, per frame) | The SDK rendered points and billboards through the Entity API                                                | One BillboardCollection per layer; picking returns layer targets (`picker.js` `pickedTarget`). By code; not measured on a GPU                                                                       |
| 3   | Each satellite orbit ring was its own entity                                                    | Per-satellite polylines                                                                                      | One shared PolylineCollection per scene, realigned every 30 s (`core/layers/satellites/definition.js`). By code                                                                                     |
| 4   | CCTV image screens could reappear after being hidden                                            | The new per-frame horizon cull re-showed any billboard in view                                               | Screens hide through their billboard, so the cull cannot re-show them (`core/layers/cctv/definition.js`, commit `743734d`). By code                                                                 |
| 5   | With thousands of contacts in view the overlay re-projected all of them up to 8 times a second  | Box choice ran every 125 ms regardless of load                                                               | Above 2,000 contacts in view it runs every 375 ms. By code                                                                                                                                          |
| 6   | The target panel's tracking widget stayed blank after the panel opened                          | Resizing cleared its canvas, and its loop stopped while the closed panel gave it no size                     | It redraws and restarts its loop on resize (`core/ui/trackWidget.js`, commit `e3f138b`). By code                                                                                                    |

### Rendering and performance

| Item                                                                  | Status                    | Evidence / notes                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Point and billboard layers on one BillboardCollection per layer       | Working (by code)         | `core/layers/sdk/createLayer.js`, `renderers.js`. Glyph canvases go into the atlas once per glyph id. Every layer definition loads through `createLayer` in the stub harness.                                                                                                                      |
| Movers re-interpolate on a ~15 Hz fleet tick                          | Working (by code)         | `FLEET_TICK_MS = 66`; camera-only frames redo the horizon cull and nothing else.                                                                                                                                                                                                                   |
| A billboard position is written only after it moved more than a metre | Working (by code)         | `distanceSquared > 1` against the last written position (each write re-uploads the collection's vertex data).                                                                                                                                                                                      |
| Horizon culling per frame without allocation                          | Working (by code)         | One reused `EllipsoidalOccluder` and scratch Cartesians per layer.                                                                                                                                                                                                                                 |
| Shared frame pacer (`core/scene/renderMode.js`)                       | Working (by code + tests) | Requests frames only while something animates, at the highest claimed rate: 30 fps full tier, 20 balanced, 15 minimal (`profile.js` `animationFps`), 60 while cockpit holds its claim. `renderMode.test.js`.                                                                                       |
| Full tier `resolutionScale` capped at 1.25, MSAA 1                    | Working (by code)         | `core/capability/profile.js`; balanced and minimal were already at 1.0 to 1.25.                                                                                                                                                                                                                    |
| Satellite orbit rings in one PolylineCollection, refreshed every 30 s | Working (by code)         | See fix 3. Needs `satellite.js`, so not run here.                                                                                                                                                                                                                                                  |
| New `polygon` render type (storm cones, fire perimeters)              | Working (by code + tests) | Ground-clamped fill and outline; ring helpers in `core/layers/sdk/rings.js` (`rings.test.js`).                                                                                                                                                                                                     |
| Raster swap without a blank frame                                     | Working (by code + tests) | `core/layers/sdk/rasterSwap.js` (`rasterSwap.test.js`), used by the timed weather overlays.                                                                                                                                                                                                        |
| New `field` render type (sampled overlays: wind)                      | Working (by code)         | `core/layers/sdk/fieldLayer.js`: fetched per view grid, drawn by the definition's own renderer, paused when backgrounded.                                                                                                                                                                          |
| Close-range 3D aircraft (`core/scene/modelLod.js`)                    | Working (by code)         | Below 800 km of camera height, aircraft within 150 km (kept to 185 km) become glTF models of their class; at most 60 on the full tier, 12 balanced, none minimal; re-chosen twice a second. On by default on the desktop, off on the phone (VIEW > 3D MODELS). Never loaded into real Cesium here. |
| Frame cost on the S25 / a Kali laptop                                 | Unverified                | Nothing was measured. First real check: the FPS meter in the bar and the VIEW > SYSTEM readout with flights on over a busy region.                                                                                                                                                                 |

### ctOS interface

| Item                                                                                                          | Status            | Evidence / notes                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tokens and primitives (`core/ui/theme.css`): mono font stack, square corners, corner frames, state colours    | Stub-checked      | Success and error are used only for state. The font is the locally installed JetBrains Mono, else a monospace fallback; nothing is downloaded.   |
| Bar: 37px, ARGUS lockup, preset cells, FPS / OBJ meters, SEARCH, feed state, UTC                              | Stub-checked      | `core/ui/hud/bar.js`, `readouts.js`. FPS and OBJ live only on the desktop bar.                                                                   |
| Desktop: LAYERS / VIEW / TOOLS menu, target panel, view stack, bottom strip (POS / ALT / HDG, timeline, TERM) | Stub-checked      | `shell-desktop/index.js`. M and T toggle the panels.                                                                                             |
| Phone: compact bar, view stack, bottom sheet LAYERS / TARGET / VIEW / TOOLS (peek, half, full)                | Stub-checked      | `shell-mobile/index.js`, `bottomSheet.js`. Not on a real phone; Samsung Internet untested.                                                       |
| Notifications (mako style)                                                                                    | Stub-checked      | `core/ui/hud/notify.js`. A repeated key replaces its card, so a failing layer shows one notice.                                                  |
| Search launcher (rofi style, `/` or Ctrl+K)                                                                   | Stub-checked      | `core/ui/hud/launcher.js`.                                                                                                                       |
| Terminal (kitty style, backtick)                                                                              | Stub-checked      | `core/ui/terminal.js`; same passive command set as before.                                                                                       |
| Boot splash                                                                                                   | Stub-checked      | `core/ui/splash.js`; reduced motion skips the animation.                                                                                         |
| Layer menu (grouped, LYR filter, per-row count / LOAD / OFF / N/A / ERR, ALL OFF)                             | Stub-checked      | `core/ui/layerMenu.js`; replaces the old toggle chips.                                                                                           |
| Linux installer font check                                                                                    | Working (by code) | `scripts/install-linux.sh` step 7 looks for JetBrains Mono with `fc-list` and prints `sudo apt install fonts-jetbrains-mono` when it is missing. |

### Map palette and icons

| Item                                                                                                                                               | Status                    | Evidence / notes                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Palette (`core/ui/palette.js`): grays, Mono Glow teals and mint; red only for hazards (fires, M6+ quakes, major hurricanes, high-severity threats) | Working (by code + tests) | `palette.test.js` keeps every registered layer in the palette.                                                                       |
| Aircraft class from ICAO type or emitter category (OpenSky `extended=1`, adsb.lol `category`)                                                      | Working (by code + tests) | `core/layers/flights/aircraftClass.js` (`aircraftClass.test.js`). Not live-tested: OpenSky's category field was never received here. |
| Ten silhouettes (airliner, widebody, four-engine, turboprop, bizjet, light, glider, helicopter, fast jet, drone)                                   | Stub-checked              | `core/ui/aircraftIcons.js`.                                                                                                          |
| Heading-up against local north (aligned axis)                                                                                                      | Working (by code)         | `renderers.js` `orient()`. Correct orientation under a tilted, rotated real camera is unverified.                                    |
| ctOS glyphs for every other layer (hull, vehicle, satellite, node, square, diamond, frame, bracket, cross, triangle, dot, pulse)                   | Stub-checked              | `core/ui/glyphs.js`, `layerGlyphs.js` (the menu tiles draw the same glyphs).                                                         |

### Selection and tracking

| Item                                                                                                  | Status            | Evidence / notes                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Click or tap selects and opens the target panel without moving the camera                             | Stub-checked      | See fix 1.                                                                                                          |
| FOLLOW (F) at the current distance, FLY TO, COCKPIT (C, movers, not on minimal), Esc releases         | Working (by code) | `tracker.js`, `cockpit.js` (capture-phase Esc leaves cockpit first). Camera behaviour needs real Cesium to confirm. |
| Tracking overlay: boxes with two-digit IDs, density OFF / LOW / MED / HIGH, dashed mesh, hub 00, LOCK | Stub-checked      | `core/scene/trackingOverlay.js`. Boxes come from feed positions only.                                               |
| Viewport frame with corner readouts (state, ID00 quality / OBJ, x/y, SIG / TRK)                       | Stub-checked      |                                                                                                                     |
| Offline city names from the bundled list (434 places)                                                 | Stub-checked      | `core/search/places.js`, shared with search and the terminal map.                                                   |
| Target panel: tracking widget driven by the nearest real contacts; CONTACTS with the same IDs         | Stub-checked      | `core/ui/targetPanel.js`, `trackWidget.js`. The widget animates at about 20 fps only while visible.                 |
| Phone: the target glides into the free area above the sheet                                           | Working (by code) | `core/scene/nudge.js` (sideways only, never a zoom). Not on a phone.                                                |

### Labels and basemaps

| Item                                                                                       | Status            | Evidence / notes                                                                                                                                  |
| ------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| DARK basemap (Esri World Dark Gray Canvas), default on capable unmetered devices           | Working (by code) | `core/scene/imagery.js`, `main.js`. Supersedes the Phase B default (Satellite). Esri's dark canvas was not reached (egress blocked).              |
| SAT, STREETS, RELIEF (offline), MONO switch                                                | Working (by code) | MONO desaturates and dims imagery and label overlays (not the already-gray dark canvas). RELIEF stays the default on metered or minimal devices.  |
| VIEW > LABELS: CITY NAMES (offline), PLACES + BORDERS, STREET NAMES (Esri reference tiles) | Partial           | City names stub-checked. The Esri reference label services (dark-canvas reference, Boundaries and Places, World Transportation) were not reached. |

### Ported reference features

All of these are "per the reference implementation, not live-tested here" for
their upstreams. Pure logic is unit-tested with fixtures.

| Feature                                                                                                      | Status                                   | Tests / evidence                                                                                                                                                                | Upstream (proxy feed)                                        |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Storm cones and tracks                                                                                       | Not live-tested                          | `forecast.test.js`, `cyclonecones.test.js` (advisory coherence gate)                                                                                                            | NHC GIS MapServer (`nhc-gis`)                                |
| Fire perimeters (US)                                                                                         | Not live-tested                          | `perimeters.test.js`, `earthFeeds.test.js`                                                                                                                                      | NIFC WFIGS (`wfigs`)                                         |
| Dams                                                                                                         | Not live-tested                          | `dams.test.js`                                                                                                                                                                  | Overpass (`overpass`)                                        |
| GOES IR                                                                                                      | Not live-tested                          | `products.test.js`                                                                                                                                                              | nowCOAST (`nowcoast`)                                        |
| Weather history timeline (VIEW > WEATHER HISTORY)                                                            | Not live-tested                          | `capabilities.test.js` (refuses DOCTYPE / ENTITY), `timeline.test.js`                                                                                                           | nowCOAST WMS GetCapabilities and timed GetMap                |
| Noir and Snow looks; sharpen and bloom (desktop)                                                             | Working (by code + tests)                | `looks.test.js` (tier gating). The shaders were never compiled on a GPU.                                                                                                        | none                                                         |
| Satellite classes and the visual group                                                                       | Working (by code + tests)                | `classes.test.js`, `groups.test.js`. Needs `satellite.js` on the globe (not installable here).                                                                                  | CelesTrak (`celestrak`)                                      |
| Starlink dense (full tier only)                                                                              | Working (by code + tests)                | `roundRobin.test.js`; never run with real TLEs.                                                                                                                                 | CelesTrak                                                    |
| NEXT PASS prediction                                                                                         | Working (by code + tests)                | `passes.test.js` with a synthetic orbit, not with `satellite.js`.                                                                                                               | none (published elements)                                    |
| Launch REPLAY (reconstructed estimate)                                                                       | Not live-tested                          | `replay.test.js`; every result carries `estimate: true` and the RECONSTRUCTED ESTIMATE label.                                                                                   | Launch Library 2 detail record (`ll2`)                       |
| 978 MHz UAT receivers (`LOCAL_UAT_URL`)                                                                      | Not live-tested                          | `localadsb/parse.test.js`; no real dump978 was available.                                                                                                                       | your own decoder (`local-uat`, local only)                   |
| TRACE 24H backfill (flights and military)                                                                    | Not live-tested                          | `trace.test.js`. Undocumented upstream path; only time, position and altitude are read.                                                                                         | adsb.lol (`adsblol-trace`)                                   |
| adsbdb enrichment                                                                                            | Not live-tested                          | `enrich.test.js` (owner fields dropped); route rows shown at run time only, never stored.                                                                                       | adsbdb (`adsbdb`)                                            |
| OSRM route planner, FLY ALONG, `argus route`                                                                 | Not live-tested                          | `osrm.test.js`, `cli.test.js`, `navFeeds.test.js` (stops, 600 km legs, 2,500 km total)                                                                                          | FOSSGIS OSRM (`osrm`)                                        |
| Draw and measure, `argus measure`                                                                            | Working (by code + tests)                | `geometry.test.js`; `argus measure London Paris` run here offline: 343.5 km, initial bearing 148.1 degrees.                                                                     | none                                                         |
| Share links in the URL hash (the address bar always holds the view)                                          | Working (by code + tests)                | `state.test.js` (decoding fails closed on anything malformed).                                                                                                                  | none (local only)                                            |
| Offline places (434) and Photon in the geocoder chain                                                        | Working offline; Photon not live-tested  | `places.test.js`, `photon.test.js`, `geocoder.test.js`; `argus geocode Tokyo` answered here from the bundled list.                                                              | Photon (`photon`), Nominatim (`nominatim`)                   |
| Analog radio tuner (TOOLS > RADIO)                                                                           | Not live-tested                          | `tuner.test.js`; https streams only; the listen counter path is per the reference.                                                                                              | Radio Browser (`radiobrowser`)                               |
| Nine camera networks (Ontario 511, DriveBC, Calgary, Fintraffic, TxDOT, Austin, Tarktee, Tallinn, Warendorf) | Not live-tested                          | `networks.test.js`, `pose.test.js`, `nearest.test.js`, `cameraFeeds.test.js`. Live Traffic NSW and DelDOT skipped (COMPARISON.md).                                              | one catalogue feed and one image-only feed per network       |
| Recent imagery (HLS, VIIRS)                                                                                  | Not live-tested                          | `catalog.test.js`, `imageryFeeds.test.js`                                                                                                                                       | NASA CMR (`cmr`), GIBS (`gibs`), Worldview Snapshots (`wvs`) |
| TomTom traffic flow raster                                                                                   | Not live-tested                          | `spec.test.js`. Needs `TOMTOM_API_KEY`. The raster path follows TomTom's documented pattern; the reference used vector tiles, so it is unverified.                              | TomTom (`tomtom-flow`, key injected, 6,000 tiles a day)      |
| Wind (Open-Meteo current 10 m wind, particle streaks; WIND readout on the desktop)                           | Not live-tested                          | `wind/field.test.js`, `windFeed.test.js`. The reference decodes GFS / ECMWF GRIB; Argus uses Open-Meteo's grid instead (no GRIB decoder could be installed), current wind only. | Open-Meteo (`openmeteo-wind`, 120 requests a day)            |
| 3D aircraft models (eight GLBs copied unchanged from the reference, CC BY 4.0)                               | Working (by code)                        | Credited in `public/models/README.md` and DATA CREDITS.                                                                                                                         | none (bundled)                                               |
| Cockpit briefing strip (desktop)                                                                             | Not live-tested                          | `briefing.test.js` (the RSS parser refuses DOCTYPE / ENTITY; news searched by place name only)                                                                                  | Nominatim reverse, Open-Meteo, Google News RSS, GDELT        |
| Data credits view (TOOLS > DATA CREDITS)                                                                     | Working (by code + tests)                | `credits.test.js`: every proxy feed and direct upstream has a credit.                                                                                                           | none                                                         |
| CLI: `argus route A B` (`--mode` car, foot or bike), `argus measure A B`                                     | Working (measure); route not live-tested | `cli.test.js`; `measure` and an exact bundled `geocode` make no outbound request.                                                                                               | as above                                                     |
| New env vars `LOCAL_UAT_URL`, `TOMTOM_API_KEY`                                                               | Working (by code + tests)                | `.env.example`, proxy feed tests; each layer is offered only when its feed is configured.                                                                                       | n/a                                                          |

### Not implemented, and why

- **Voice control**: out of scope by the `CLAUDE.md` guardrail.
- **Mapillary street level**: needs a token in the browser, which conflicts
  with "no secrets in client code", and its imagery shows people. Parked for
  the owner's decision.
- **Traffic simulation**: the reference's vehicles are fabricated. Only
  TomTom's real flow raster was ported.
- **Wind from GFS / ECMWF GRIB** (the reference's approach): needs a
  server-side GRIB decoder dependency that could not be installed here
  (registry blocked). The Wind layer uses Open-Meteo's current wind grid
  instead, so there is no forecast timeline.
- **WebUSB SDR, HLS camera video, hosted scene sharing**: deferred (the
  scene director itself is in Phase F, local only).

### Verified in this pass

Re-run on a clean export of commit `e3f138b` (the counts grew with each
commit: 459 core passes at `8256f92`, 462 at `743734d`):

- `npm test` (core, mobile shell, terminal shell): 465 pass, 2 fail. The two
  failing suites (`core/layers/satellites/propagate.test.js`,
  `core/scene/occlusion.test.js`) import `satellite.js` / `cesium`, which could
  not be installed.
- `npm run test:proxy`: 96 of 96 pass with a `ws` implementation (Playwright's
  bundled copy, mapped in by a scratch loader). Without `ws`, 82 pass and the
  four websocket suites fail to load.
- The CLI offline paths: `argus measure London Paris`, `argus measure` with
  coordinates and `--json`, and `argus geocode Tokyo` (answered from the
  bundled list).
- The terminal shell on demo data: a frame rendered headless at 100 columns
  (the one in the README), with the bundled city names and the longer layer list.
- The web UI in the stub harness, as described under the environment limits.

### Still unverified or incomplete (and why)

- **Everything on real Cesium**: the BillboardCollection renderer, the frame
  pacer's real frame rates, heading-up silhouettes under a tilted camera, the
  overlay's alignment with real projected positions, shader compilation, label
  tiles, the wind streaks, and the 3D aircraft models (orientation, scale,
  picking). First check on Kali: `npm install && npm start`, flights on over a busy
  region, the FPS meter, a click on an aircraft (panel opens, camera stays),
  FOLLOW, Esc.
- **Every new upstream, live** (egress blocked): NHC GIS, WFIGS, nowCOAST
  GetCapabilities and GOES, NASA CMR / GIBS / Worldview Snapshots, adsb.lol
  traces, adsbdb, OSRM, Photon, Open-Meteo (briefing and wind), GDELT, Google
  News RSS, the nine
  camera networks, TomTom raster flow, Esri dark canvas and reference labels.
- **Phone**: the bottom sheet, the glide above the sheet, thermal behaviour of
  the new renderer, the tracking overlay and the wind streaks on the S25, and
  whether 12 models fit the balanced tier's budget.
- **Satellites on the globe** (stations, classes, Starlink dense, NEXT PASS from
  real TLEs): need `satellite.js`.
- Unchanged from earlier phases: keyed feeds without keys here, photoreal
  tiles, CertStream upstream silence, CCTV and threats demo-only.

## Phase F: parity round 2 and the independent review

Same environment limits as Phase E (no network, no real Cesium; the web UI
was checked in the stub harness only).

### Fixed from an independent review of Phase E

| Finding                                                                                    | Status |
| ------------------------------------------------------------------------------------------ | ------ |
| The fifth notification froze the tab (a dismiss loop that never shrank)                    | Fixed  |
| Target card buttons kept the previous target's actions when labels matched                 | Fixed  |
| Taps on line layers (cables, perimeters, cones, arcs) no longer selected                   | Fixed  |
| adsbdb enrichment never showed (a cached answer is wrapped as `{ value }`)                 | Fixed  |
| A second REPLAY press during the detail fetch leaked a run and its render claim            | Fixed  |
| Movers moved at half the paced frame rate                                                  | Fixed  |
| Escape in the launcher or terminal also dropped the target                                 | Fixed  |
| TxDOT JSON stills never displayed                                                          | Fixed  |
| TRACE 24H barely showed (the trail took only the newest 48 fixes)                          | Fixed  |
| Hub brackets drew for a target behind the globe                                            | Fixed  |
| Polygons and lines re-tessellated on every poll                                            | Fixed  |
| A radio stream could not be stopped after the Radio layer went off                         | Fixed  |
| A 3D model hid its glyph before it drew; a missing model was re-requested twice a second   | Fixed  |
| The first drill-pick won even when it was the trail or a sketch line                       | Fixed  |
| Phone radio tuner steps switched the sheet to TARGET                                       | Fixed  |
| The phone nudge lowered the camera on a tilted view                                        | Fixed  |
| Route fly-along ignored terrain                                                            | Fixed  |
| Share links: one unknown value discarded the whole link; VIEW controls did not repaint     | Fixed  |
| Proxy relay: no nosniff / CSP, image feeds passed any body, redirects followed blindly     | Fixed  |
| The wind budget was spent by a few minutes of panning                                      | Fixed  |
| Satellite rings propagated while the layer was off; a decayed satellite could flicker back | Fixed  |
| `gnews` / `gdelt` accept any printable text (the client sends place names only)            | Noted  |
| Esri basemap and labels and radio audio load straight from their hosts, not via the proxy  | Noted  |

### Added

| Feature                                                                            | Status       | Tests                                     |
| ---------------------------------------------------------------------------------- | ------------ | ----------------------------------------- |
| Keyboard shortcuts (H, O, V, D, N / P, 1 to 6, ?) and the shortcut list            | Stub-checked | `core/ui/keymap.test.js`                  |
| Intel HUD: MGRS, DMS, GSD and NIIRS, sun elevation, off-nadir angle, nearest place | Stub-checked | `core/geo/*.test.js`, `intelHudModel`     |
| Clean view (V) with a UI chip to come back; orbit (O)                              | Stub-checked |                                           |
| Contact cycling: N / P and PREV / NEXT on the contacts header                      | Stub-checked |                                           |
| Presets give the view back on exit (the reference's Global Context)                | Stub-checked |                                           |
| Scenes: capture, play as a tour, loop, save locally, export / import JSON          | Stub-checked | `core/share/scenes.test.js`               |
| Landmarks: nine cities, public places only, in TOOLS and search                    | Stub-checked | `core/search/pois.test.js`, search tests  |
| PROJECT: a traffic camera's still in 3D at its frustum's far plane, pose gizmo     | Stub-checked | `core/layers/trafficcams/projection.test` |
| Cockpit weather: haze, fog, cloud, rain, snow, droplets, storm flashes             | Stub-checked |                                           |

### A second review of this phase (fixed)

- Orbit overrode every camera move it did not make (zoom buttons, fly-to,
  presets): it now stops before any move through the camera controls, and
  yields on the next frame to any other.
- The proxy's hand-followed redirects carried credentials to another origin:
  `authorization`, cookies and injected key headers are now dropped on a
  cross-origin hop. The private-host check also covers IPv4-mapped IPv6 and
  unspecified addresses.
- A preset pressed twice quickly threw; a scene left a stale preset restore;
  N with nothing selected skipped the first contact and could select a
  contact that had left its layer; a slow PROJECT could land after the
  selection moved on; the cockpit weather ran frames with nothing to draw.

### Still unverified (and why)

- All of the above on real Cesium: the orbit's `lookAt` handoff, the HUD's
  centre pick, the projection quad's orientation and texture, the landmark
  views' framing over real terrain, and scene playback timing.

## Phase G: more cameras and layers, real filters, settings, saved places, Android app

Same environment limits as before (no network, no real Cesium or `node_modules`; the web UI was checked in the stub-Cesium harness, every switch toggled and verified to change scene state, and every layer enabled without error).

Added this phase:

- **Public webcams** (`webcams`) over Windy v3, NPS, NASA EPIC and a curated observatory catalogue, 15 categories with a VIEW filter; **more traffic cameras** (all Caltrans districts, NYC DOT, Singapore LTA, WSDOT, ten 511 states) with sub-kinds and a filter; **border waits** (CBP/CBSA on a bundled 58-port table).
- **Context layers**: aurora, air quality, day/night terminator, Tor relays, GDELT events; plus **traffic incidents** (TomTom) and **CHP incidents**.
- **ALPR view cones** on surveillance cameras (batched ground primitive, degrades to points where ground primitives are unsupported).
- **Real sensor filters** (NVG, FLIR with four palettes, CRT; each compiled in WebGL2), **more Earth basemaps** (Sentinel-2, Blue/Black Marble, OpenTopoMap) and globe options (lighting, atmosphere, stars, exaggeration, detail).
- **Settings** and a **Setup tab** (keys saved to the proxy machine over a loopback-only, same-origin, header-gated endpoint, never the browser), **saved places**, **watch areas**, **situation tour**, **compare**, and **interactive tracking** with closest-approach conflict alerts.
- An **Android app** (`android/`, WebView + nodejs-mobile proxy) and an **Android Auto** map on a new car shell (`shell-car/`), built by a GitHub Actions workflow.

Tests this phase: core/mobile/terminal/car 643 of 645 pass (the two are `propagate.test.js` and `occlusion.test.js`, needing `satellite.js` / `cesium`); proxy 128 of 128; lint and `prettier --check` clean.

Still unverified (and why):

- **Everything on real Cesium**: the new shaders on a real GPU, the ground-primitive view cones and incident roads draping on terrain, the aurora / air-quality / terminator field textures, and the strip readouts.
- **Every new upstream, live** (egress blocked): Windy, NPS, NASA EPIC, the 511 / WSDOT / NYC / Singapore camera networks, CBP and CBSA border waits, TomTom incidents, CHP CAD, NOAA SWPC, Open-Meteo air quality, NASA Black Marble, Onionoo, GDELT. Endpoint and coordinate uncertainties are listed in the agents' integration notes; the first online run is the real check.
- **The Android app**: never built (no Android SDK) or run on a phone or in a car. The first CI run compiles it; `NODEJS_MOBILE_SHA256` must be pinned from that run's printed checksum, and WebGL through the car VirtualDisplay is unverified.

## Phase H: Android Auto, lighter and easier

Measured in the stub-Cesium harness with a simulated drive (GPS fixes at 1 Hz like the app: 30 s at 90 km/h, 10 s parked, 10 s parked with GPS wander, 40 s at 126 km/h), on main and on this change, same layers (flights, quakes, traffic cameras, surveillance, incidents):

| Phase              | Frames/s before | after | Viewport-layer refetches before | after                     |
| ------------------ | --------------- | ----- | ------------------------------- | ------------------------- |
| Driving            | 26              | 24    | 0 in 30 s (never followed)      | 1 per layer (drift check) |
| Parked             | 21              | 11    | surveillance 6 in 10 s          | 1                         |
| Parked, GPS wander | 28              | 10    | 3                               | 0                         |
| Motorway           | 26              | 22    | 0                               | 1 per layer               |

Parked with no aircraft on, the car now draws nothing at all (0 frames/s); the remaining parked frames are aircraft moving at 8 a second. Main-thread task time in the harness dropped about fourfold, mostly from the smaller render target.

What changed:

- **Layers follow a camera that never settles**: viewport layers refetched only on Cesium's `moveEnd`, which never fires while the car follows the vehicle (nor while a desktop camera follows a tracked aircraft). They now also check every 4 s and refetch once the view has drifted a third of a view, and skip refetching when it moved under 4 % (`viewportShift`, `core/layers/sdk/viewport.js`). Tested.
- **Parked**: every GPS fix nudged the follow camera, which fired `moveEnd` about once a second and re-queried Overpass for surveillance cameras each time. The follow view no longer touches the camera once settled, and GPS wander while parked is held still (`isParkedJitter`). Tested.
- **The car keeps its own light look**: phone settings (imagery, terrain including photoreal 3D tiles, sun, atmosphere, stars, exaggeration) no longer reach the car, which shares the phone app's origin and storage.
- **Frame budget**: render target held to about 1.1 MP whatever the car display (`carResolutionScale`); follow view 20 updates/s moving, 12 creeping; aircraft 8/s; no backdrop blur over the map. The thermal ladder's resolution step now has its floor in CSS pixels, so it always lowers.
- **Android side**: drags and pinches are batched into one call per display frame (`Choreographer`); zoom factors keep four decimals (two dropped slow pinches); the car WebView pauses when the surface goes or another app is in front, and location stops with it.
- **Easier to use**: aircraft drawn on their ground track in the car (the camera looks down from below cruise altitude, so they were never in view); a closer follow view (1.8 to 6.5 km); VIEW cycles 3D / 2D / north up; LAYERS opens with Drive and Sky presets and lists only layers the page can show, within the host's list limit; the HUD leads with a large speed; the nearest-contacts readout puts what is ahead first.

Still unverified (and why): the Kotlin compiles only in CI (no Android SDK here); behaviour in a real car or the Desktop Head Unit, WebGL through the VirtualDisplay, and whether `WebView.onPause` hides the page on every WebView version are untested on a device.

## Phase I: Android Auto as a navigation app, and the owner's round-6 list

Built in six parallel work areas and integrated on one branch. Each area's full notes (files, wiring, settings keys, feeds, tests, harness runs) are in `docs/round6/`: A merge nearby, picking, gestures, fetch once; B logs, feed reliability, CHP, news, key transfer; C navigation; D Android Auto as a GPS and the VEHICLE panel; E1 surveillance, traffic lights, camera previews, landmarks; E2 simulated traffic, street photos, Shodan, TomTom, smooth motion; F your own position and marker. Everything lands in every shell (desktop, Linux, phone, Android Auto via `shell-car`, and where it makes sense the terminal).

| Asked for                                                                   | What it is now                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Android Auto as a map, easy destination, traffic and lights, avoid highways | Car: WHERE TO search (recents, search as you type), route preview with up to 3 routes (time, traffic delay, lights, "no highways"), Avoid hwy switch, NavigationTemplate turn cards with ctOS maneuver icons, ETA, reroute, arrival. Desktop and phone: the same `core/nav` behind a WHERE TO bar, long-press / right-click ROUTE HERE, turn banner. OSRM and Valhalla (FOSSGIS), TomTom when keyed; OSM traffic lights along the route add an expected wait |
| Car stats in ctOS, image of the car, fuel, mpg, auto hide when driving      | VEHICLE panel: make, model, year, a sedan / SUV / EV silhouette, fuel and battery %, range, odometer, average MPG or L/100 km from the fuel drop since the last fill-up; shown parked, hidden above walking speed and on a route. Values come from Android Auto's CarInfo where the car shares them; unknowns read `--`                                                                                                                                      |
| Static items fetched once, or reloaded by hand                              | Cameras, ALPR readers, landmarks and traffic lights: 0.1 degree tiles kept 12 to 24 h, nearest first; data centres, installations and dams: the Layer SDK's tile cache (1 to 2 degree tiles, 24 h). RELOAD beside each layer                                                                                                                                                                                                                                 |
| Error popups to a logs tab, light                                           | SETUP > LOGS: a 300-entry ring, repeats folded, nothing built while closed; popups only for things you asked about                                                                                                                                                                                                                                                                                                                                           |
| Merge close items unless zoomed in; lag zoomed out                          | MERGE NEARBY, on by default above 3 km camera height; harness: 4,376 billboards drawn to 578 on the desktop, 33 ms to 7 ms per frame; phone 43 ms to 5 ms                                                                                                                                                                                                                                                                                                    |
| Better pinch, double tap in, triple tap out; taps through the earth         | Pinch follows the fingers; double tap x2 in and triple tap x2 out about the point; contacts beat lines beat areas under a tap; nothing behind the planet is picked; Cesium's own click handlers (a second pick, entity camera lock) removed                                                                                                                                                                                                                  |
| Slow GEO, no icon for me, choice of icons                                   | Last known place at once, then refined; native GPS in the Android app; seven ctOS markers (chevron, ctOS triangle, diamond, car, crosshair, dot, beam) with heading, accuracy ring, follow-me                                                                                                                                                                                                                                                                |
| More surveillance in ctOS style                                             | ALPR (incl. DeFlock mapping), acoustic sensor, red-light, average-speed, speed, toll, PTZ, dome, fixed cameras, guard posts, each its own glyph; nearest 60 by default, ALL IN VIEW as a choice                                                                                                                                                                                                                                                              |
| CHP and news mostly not working                                             | CHP: the parser read 0 incidents from the live feed (`ID = "..."` spacing), and one server in three served a truncated hour-old copy; both fixed (146 incidents from a live sample), with retries and stale-if-error. News: GDELT's GEO API is gone (404); replaced by the GDELT 2.0 Events export unzipped in the proxy                                                                                                                                     |
| Waze traffic API                                                            | Added on the owner's follow-up (personal, educational use; off by default): Waze alerts (unofficial) with accidents, jams, hazards, closures, construction and police reported, from the live map's endpoint or the owner's own waze-server (`LOCAL_WAZE_URL`). User positions, reporter names and free text are never read; nothing is archived. Waze answered 403 to Argus's honest User-Agent from this container                                         |
| Traffic (simulated) with TomTom flow, congestion colours below 8 km         | Added: OSM roads, IDM car following, fleet capped by tier, speeds and green / amber / red from TomTom Flow Segment Data (450 a day), labelled SIMULATED, never pickable                                                                                                                                                                                                                                                                                      |
| Traffic lights from OSM                                                     | Added (junctions; crossings under 6 km and not in the car)                                                                                                                                                                                                                                                                                                                                                                                                   |
| Street level photos (Mapillary)                                             | Added with the token in the proxy and no photographer fields; STREET PHOTO on any ground card                                                                                                                                                                                                                                                                                                                                                                |
| Smooth motion from choppy data                                              | Movers bracket across every retained fix with the source's report time, dead-reckon past the newest, and ease; per-tick speed within about 3 % of the median on the harness                                                                                                                                                                                                                                                                                  |
| More TomTom                                                                 | Flow segments (simulated traffic, ROAD FLOW readout, `argus flow`), traffic-aware routing, place search                                                                                                                                                                                                                                                                                                                                                      |
| Camera stills without tapping                                               | CAMERA PREVIEWS: the 4 (up to 8) cameras nearest the middle of the view show their still beside the icon when zoomed in; off in the car                                                                                                                                                                                                                                                                                                                      |
| Shodan works and does more                                                  | Fixed an unquoted default query, an uncached feed and unanchored paths that let any free-text search through; 10 curated snapshots, country cards, opt-in host sample, InternetDB (keyless) in the console and on any card with an IP, LOOK UP AS on BGP cards                                                                                                                                                                                               |
| Landmarks useful                                                            | TOOLS > LANDMARKS is NEARBY: named OSM landmarks around the view, Wikipedia first, fly-to and SAVE                                                                                                                                                                                                                                                                                                                                                           |
| Import and export keys, securely                                            | SETUP > KEYS: export as scrypt + AES-256-GCM with a passphrase (10+ characters), import a keys file or `.env` lines; loopback, same-origin, header-gated, values never logged or returned                                                                                                                                                                                                                                                                    |

Integration decisions: the surveillance, landmarks and traffic-light layers keep their own nearest-first tiling (anchored to your position for NEAREST, shared with TOOLS > LANDMARKS) rather than also going through the SDK tile cache, which would have tiled the same view twice; RELOAD reaches them as `query.reload`. A view somewhat wider than the tile budget loads its nearest tiles ("zoom in for more") instead of nothing. The car does not draw the browser's route view or puck (Android Auto draws its own).

Verification: GitHub Actions now runs `ci.yml` (eslint, prettier, both test suites with the real packages) on every push: green on this branch with 901 core and shell tests and 178 proxy tests, all passing (including the ones that need `cesium`, `satellite.js` and `ws`, which this container could not install after a restart). The Android workflow builds the APK from the branch (the web app with real Cesium, the Kotlin, the embedded proxy) and now verifies the nodejs-mobile download against a pinned sha256. In the container, the browser harness (stub Cesium, headless Chromium) boots desktop, phone and car with no page errors, drives a car route end to end (search, preview, turn-by-turn, arrived), keeps every layer inside its fetched area over a simulated drive, and draws the Waze layer from its demo source.

Still unverified (and why): nothing ran on real Cesium or a GPU (clustering projection, pinch feel, ground polylines, the self marker), on a phone, in a car or the Desktop Head Unit; the Kotlin compiles only in CI; TomTom, Mapillary and keyed Shodan ran against documented shapes only (no keys here); no request went through the proxy to a live upstream from this container (curl samples became fixtures); car data permissions are per the Car App Library documentation, not checked on a device.
