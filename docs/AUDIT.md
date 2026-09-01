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

### 2. Many switches do nothing -> Working in dev-mock and dev+proxy; Broken in a bare production build

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

### 4. "Around Me" is wonky -> Partial (mobile only; desktop is a no-op; framing is coarse)

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

### 5. No "center on my location" button -> Missing

- There is no dedicated locate-me control in either shell. The only geolocation
  entry point is the "Around Me" preset, and only on mobile. Confirmed by search
  (`grep locate` finds nothing) and by inspecting both shells.

### 6. Arcs/lines/points look flat -> Partial (points flat; arcs and trails already styled)

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

| Control                         | Status                    | Evidence                                                                                                                                                                                                                            |
| ------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layer toggles (11)              | Working                   | All toggled on with live counts; visual state tracks real state. In a bare prod build they would be inert (see item 2). `core/ui/layerToggles.js`.                                                                                  |
| Presets (5)                     | Partial                   | Around Me / Sky / Disaster / Environment / Surveillance apply their layer sets. "Around Me" on **desktop** does not geolocate (no-op camera). `core/presets.js`.                                                                    |
| Global search + geocoder fly-to | Working                   | Typed "Tokyo" -> combined entity + place results -> selecting "Tokyo, Japan" flew the camera there. Real geocoder path (Nominatim) is correct. Minor: unrelated threat entities matched "Tokyo" (loose relevance). `core/search/*`. |
| Metadata card                   | Working                   | Clicking a quake showed M 7.4 with magnitude/depth/time/coordinates. `core/ui/metadataCard.js`.                                                                                                                                     |
| Click / tap to track            | Working                   | Selected entity `mq6`; camera followed. `core/interaction/picker.js`, `tracker.js`.                                                                                                                                                 |
| Trails                          | Working                   | Glowing tapered polyline + halo ring on the tracked entity. `tracker.js`.                                                                                                                                                           |
| Sensor shaders (NVG/FLIR/CRT)   | Working                   | NVG verified (full green night-vision with vignette/noise). CRT is full-tier only and hidden on mobile. `core/shaders/sensorShaders.js`.                                                                                            |
| In-app terminal                 | Working                   | `help`, `layers` (listed all layers `[on]`), and `query` all ran. `core/ui/terminal.js`, `core/osint/terminal/commands.js`.                                                                                                         |
| Capability readout              | Working                   | Live tier/GPU/counts panel. `core/ui/capabilityReadout.js`.                                                                                                                                                                         |
| CT firehose ticker              | Partial                   | UI + toggle implemented; connects `/ws/ct` on toggle. Public CertStream upstream is often silent and needs `CT_STREAM_URL`; dev uses a synthetic stream. Real data not confirmed. `core/ui/ctTicker.js`, `core/osint/ct/*`.         |
| Time scrubber                   | Working (by code + tests) | Clock + ring-buffer history + UI wired; movers rewind against the shared clock. Rewind not drag-tested this session. `core/ui/timeScrubber.js`, `core/scene/clock.js`, `core/layers/sdk/ringBuffer.js`.                             |
| Cockpit mode                    | Working (by code)         | Offered for movers when tier is not minimal; not runtime-ridden this session. `core/interaction/cockpit.js`.                                                                                                                        |
| Compass / point-at-sky          | Working (by code + tests) | Mobile-only "Point at sky" button present; DeviceOrientation math unit-tested. Not sensor-tested in-browser. `shell-mobile/compass.js`, `orientation.js`.                                                                           |
| Around Me (geolocation)         | Partial                   | See known problem 4.                                                                                                                                                                                                                |
| Locate-me button                | Missing                   | See known problem 5.                                                                                                                                                                                                                |

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
| Extra: BGP RIS Live `/ws/bgp`      | Working (by code + tests)                                | Keyless; lazy upstream connect on client subscribe.                             |
| Extra: CT CertStream `/ws/ct`      | Partial                                                  | Implemented; upstream often silent, needs `CT_STREAM_URL`.                      |
| Feed allowlist (anti-SSRF)         | Working                                                  | Off-allowlist path -> 403 "path not in feed allowlist".                         |

Minor: `/health` reports `phase: 3` and marks keyed feeds (firms/shodan)
`configured: true` even without their secrets; only OAuth (opensky) reflects secret
presence. Cosmetic, but the health report is not fully truthful about keyed feeds.

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
