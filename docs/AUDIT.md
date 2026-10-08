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
