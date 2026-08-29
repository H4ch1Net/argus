# CLAUDE.md

Operational guide for working in this repository with Claude Code. Read this before writing code. The full rationale for every rule here lives in `gods-eye-view-master-plan.md`; this file is the short, binding version.

---

## What this project is

A live 3D globe (CesiumJS) that visualizes public data feeds: aircraft, ships, satellites, earthquakes, weather, surveillance infrastructure, and internet-infrastructure telemetry. It is a cybersecurity research project. It runs as one web app on three targets, in priority order: Samsung S25 Ultra (mobile-first), Linux, Windows.

Based on `bilawalsidhu/gods-eye-view` (MIT, code only; data feeds keep their own terms).

---

## GUARDRAILS (non-negotiable, read first)

This project visualizes data that is already public. It never generates new surveillance of people and never acts against a target. Apply this test to any feature or code change:

> Does this query something already public, or does it act on / identify a specific person or target?

Reading already-public data is in scope. Creating new tracking of individuals, or acting against a host, is out.

**Never implement, even if asked mid-build:**
- **ALPR / plate reading.** No computer vision on camera feeds to extract or track license plates or vehicles. Mapping where cameras/readers are located is fine; reading what they see is not.
- **People-targeting OSINT.** No people-search, breach-data lookups on individuals, face/username-to-identity resolution, or social-media scraping to locate someone. Inputs are assets (IP, domain, cert, ASN, network), never people (name, username, face, phone).
- **Active / offensive tooling.** The in-app terminal and OSINT console run passive public-index lookups only. No port scanning, nmap/masscan, exploit frameworks, packet crafting, or anything that sends traffic at a third-party host. It reads indexes (Shodan already scanned it, CT already logged it, RIPE already published it); it does not touch targets.
- **Voice control.** Out of scope entirely.

If a task drifts toward any of these, stop and flag it rather than implementing.

---

## Stack and conventions

- **CesiumJS + Vite + vanilla JS.** No framework (no React/Vue).
- **Input: Pointer Events only.** Never bind mouse, touch, or pen separately. Branch on `pointerType` only where genuinely required (pen pressure for the CCTV gizmo, hover for desktop tooltips).
- **No secrets in client code, ever.** Every API key, token, and secret lives behind the proxy (see below). If you find yourself putting a key in browser-reachable code, that is a bug.
- **No em dashes** in generated docs, comments, or committed prose. Use colons, commas, or parentheses.
- **Prefer editing existing files** over adding new ones. Keep the core/shell boundary clean (see Architecture).

---

## Architecture: shared core, two shells

One repo. Roughly 80% of the code is shared; only input, layout, and quality diverge. Do not fork the data engine.

```
/core      shared engine: Layer SDK, data integrations, proxy client,
           Cesium scene, entity/trail/interpolation, SGP4, presets, search
/shell-mobile   S25-tuned: bottom-sheet UI, touch+pen, phone quality
                defaults, geolocation "Around Me", compass mode, PWA
/shell-desktop  Linux/Windows: side-panel UI, mouse/keyboard,
                quality unlocked upward (photorealistic, 60fps, shaders)
/proxy     the backbone service (see below)
```

Rules:
- **Nothing in `/core` may require a mouse, keyboard, or desktop GPU.** Mobile is the baseline; desktop unlocks upward from it. A feature that only works with a mouse belongs in a shell, not core.
- **Sensors (geolocation, orientation) are shell inputs, not core.** Core exposes "set camera to X" and "track entity Y". The mobile shell translates GPS/compass into those calls. Desktop shell never imports sensor code.
- **Capability is runtime state, not a build target.** Detect GPU limits, memory, touch-vs-pointer, network type, and screen size at load, then branch on a capability tier. Do not branch on "is mobile".

---

## The proxy (the actual backbone)

Every real feed routes through it. It is one service with six jobs:

1. **Key/secret broker.** No secret reaches the browser.
2. **OAuth2 token manager** (OpenSky): fetch, cache, refresh ~30s before expiry.
3. **CORS shim** (many feeds send no CORS headers).
4. **HTTPS terminator.** Required because mobile hard-blocks HTTP feeds, including bare-IP and local-network endpoints the browser will not auto-upgrade.
5. **Stateful AIS websocket consumer.** AISStream forbids direct browser connections; the proxy holds the connection and fans out only what each client needs. Enable permessage-deflate.
6. **Rate/budget governor** in front of every metered API (Google 3D Tiles, Shodan). This is what stops a panning session from burning a month of credits.

---

## The Layer SDK contract

Every layer, physical or internet, follows one shape:

```
fetch (poll | push | once | compute)
  -> normalize to { id, position, type, meta, velocity? }
  -> render (renderType: point | billboard | trail | raster | arc)
  -> interpolate? (movers only)
```

- New layers should be **config against this interface, not bespoke code.**
- `renderType` handles entities, raster/field overlays (weather, air quality), and threat-map arcs through the same interface. Do not build a parallel subsystem for rasters.
- **Fetch is viewport/radius-bounded from the start.** This serves performance, credit budgets, and the mobile "Around Me" query at once.
- **Clustering, viewport culling, and load-only-enabled-layers-in-view live in the interface itself.** Mandatory at this layer count, doubly so on mobile.
- **Interpolation:** render about one polling interval behind real time and tween between fixes. This is what makes 15 to 30s feed updates look smooth.
- **Satellites:** SGP4 via satellite.js, with GMST realignment to keep orbit rings locked without drift.

---

## Mobile constraints that affect code (S25 Ultra: Adreno 830, QHD+ 120Hz)

- **Set `resolutionScale` explicitly** (about 1.0 to 1.5). Do not follow `devicePixelRatio` (~3.5 to 4 at QHD+ will throttle within minutes).
- **Cap `targetFrameRate`:** 30 ambient, 60 cockpit. Do not chase 120.
- **Use `requestRenderMode`.** Render only on change; near-zero cost with static layers and a still camera.
- **Handle `webglcontextlost` / `webglcontextrestored` from day one.** Context loss is routine on Android. A full page reload is not an acceptable recovery.
- **Post-processing shaders (NVG/FLIR/CRT):** render at reduced resolution and upscale; multi-pass stacking is desktop-only. Biggest thermal risk on the phone.
- **Thermal budget ladder** (detect via rising frame-time trend; Android exposes no thermal API to the web): full quality -> drop post-processing -> drop resolutionScale -> drop to free terrain.
- **Wake Lock** for cockpit mode only. **Page Visibility** pauses poll loops and the AIS socket when backgrounded, with explicit resume.
- **Cap 3D-tile cache** (`maximumCacheOverflowBytes`, tileset `maximumMemoryUsage`).
- **Touch picking:** billboards are a few pixels; fingertips are ~8 to 10mm. Use a drill-pick radius or oversize pickable geometry, plus a movement/time threshold to distinguish tap from drag.
- **Cellular:** use the Network Information API to default to free terrain; photorealistic tiles are explicit opt-in.

---

## Cesium init gotchas

- Cesium sets `failIfMajorPerformanceCaveat: true` by default: it hard-fails (does not slow-fallback) if it only gets software rendering. On Linux (Kali / b1t), confirm `chrome://gpu` shows hardware acceleration before debugging anything else. This is pass/fail for the app starting at all.
- Serving to the phone over LAN needs HTTPS, or geolocation, orientation, and service workers silently no-op.
- Test Samsung Internet as well as Chrome.

---

## Locked decisions (do not relitigate in code)

- Terrain: Cesium free is the default; Google Photorealistic 3D Tiles are an opt-in toggle (off by default on mobile/cellular).
- History: log fixes to a bounded in-memory ring buffer now (nothing persisted to disk); the scrubber UI is a later phase.
- Presets are first-class core UX: Around Me, Sky, Surveillance, Disaster, Environment.
- Default-on layers: flights + earthquakes + one transit feed. Mobile launches into Around Me.
- Global search/fly-to is in scope, staged mid-build; it grows into the OSINT query console.
- Shodan is visualization/awareness-only, built on cached/snapshot queries, never live search-on-pan.
- Mobile is reduced-by-design (no heavy stacked shaders or full cockpit on phone).

---

## Verification discipline

Treat the feed catalog as candidates. Feed availability, terms, and rate limits change constantly. **Confirm a source's current terms at the moment you build its layer, not before.**

Verified as of the planning session (still re-check before relying on them): OpenSky (OAuth2, viewport-bound), AISStream (no browser connections, ~300 msg/s, compression mandatory from Sept 2026), NASA FIRMS (5,000 transactions / 10 min, viewport-bound), mobile mixed-content blocking, Shodan (student free Membership via .edu; search costs credits, IP lookups are free), Cesium hard-fail on software rendering, Android WebGL context loss.

Not yet verified: GreyNoise, AbuseIPDB, CISA KEV, CT logs, RIPE RIS/BGP, honeypot feeds, GTFS-RT specifics, and the remaining free feeds. Verify each at build time.

---

## Build order (each phase ships something visible)

1. Bare Cesium globe + terrain + capability-tier scaffolding
2. Proxy v1 (key broker + CORS + HTTPS terminator)
3. Flights layer (proves the pipeline) + OpenSky OAuth2 in proxy
4. Click/tap-to-track + trail + metadata card (the interaction spine)
5. Formalize the Layer SDK
6. Satellites + earthquakes
7. Presets + default state + mobile shell v1 (Around Me)
8. Cockpit mode
9. Sensor shaders (desktop-favored, mobile-gated)
10. Ships (AIS via proxy) + fires (+ radio/bikeshare if time)
11. Overpass integration (landmarks + Flock/ALPR locations + public cameras)
12. CCTV projection (hardest: camera pose estimation)
13. Shodan layer (cached queries; budget governor live)
14. Compass / point-at-sky mode
15. Global search / fly-to
16. OSINT/cyber console: threat-map arcs -> query console -> asset correlation -> CT/BGP -> terminal
17. Time scrubber UI

---

## Commands

_Not yet scaffolded. Fill in as the project is set up._

```
# dev server
# build
# lint / format
# serve to phone over LAN (HTTPS required)
```

---

## Deferred (do not design for these until asked)

Club/CODIS concerns: deployment model (local-first per member vs shared deployment), shared state, attribution-as-teaching. General hosting/deployment. Overpass public-instance vs self-hosted. When these come up, the working default is local-first per member (simplest key story, no shared-infra liability).
