# Round 6, worker E1: surveillance, traffic lights, camera previews, nearby landmarks

Branch `worktree-agent-acc51428b69f29d67`, based on main (fece91d), with the
integration commit 2231757 merged in (clean, no conflicts).

GUARDRAIL: everything here maps where public infrastructure is, from
OpenStreetMap. Nothing reads, measures or analyses what a camera, reader or
sensor sees or hears. Camera previews show the published still as is.

## What I built

1. **More surveillance** (`core/layers/surveillance/`). One Overpass query per
   0.1 degree tile asks for `man_made=surveillance` (nodes and ways),
   `highway=speed_camera`, and `type=enforcement` relations with their `device`
   member nodes. Kinds (`kinds.js`), each with its own ctOS glyph:
   ALPR reader (`surveillance:type` ALPR / ANPR / LPR, which covers DeFlock's
   mapping), acoustic sensor (`gunshot_detector`, e.g. Flock Raven), guard post,
   red-light camera (`enforcement=traffic_signals`, `speed_camera=traffic_signals`),
   average-speed camera, speed camera, toll gantry camera, PTZ camera
   (`camera:type=panning|panorama_with_ptz`), dome camera (`dome|panorama`),
   fixed camera (the rest). A relation's `enforcement` wins over the device
   node's own (Paris has red-light devices tagged `enforcement=check` on the
   node); a relation device that is a plain road node of an unmapped rule is
   skipped. Cards: type, operator, maker, name/ref, scope (`surveillance`),
   zone, camera type, mount, enforces / limit / section (relation name),
   mapped facing, tilt, height, source ("OpenStreetMap (DeFlock mapping)" for
   ALPR), coordinates, an OpenStreetMap link. View cones kept; enforcement
   cameras get a narrower, longer default cone (30 deg, 90 m); acoustic sensors
   and guard posts get no cone or ring.
   - **Nearest by default**: the nearest 60 to the middle of the view, or to
     your own position while the view follows you; **ALL IN VIEW** as a VIEW
     choice (capped nearest first at 4,000, 2,000 on the minimal tier). In
     NEAREST mode the source loads only the 2 x 2 tiles around the anchor
     (fewer Overpass requests); ALL IN VIEW loads up to 3 x 3.
   - **Fetched once**: tiles are kept 12 h (in memory); RELOAD OSM (VIEW >
     SURVEILLANCE) refetches surveillance, traffic lights and landmarks. A
     failed tile is not kept and waits 45 s before it is asked again; tiles
     arriving in the background refresh the layer (the first pass waits only for
     the tile under the anchor).
2. **Traffic lights** (`core/layers/signals/`, key `signals`, label "Traffic
   lights", group "Ground & sea"): `highway=traffic_signals` (junctions) and
   `crossing=traffic_signals` (pedestrian crossings), only in views about 20 km
   across or less ("zoom in to load" otherwise), tiles kept 24 h. Crossings draw
   smaller and only under 6 km, never on the minimal tier (the car). Signal-head
   glyph, pale ink, card (mode, facing, sound, vibration, button, island).
3. **Camera previews** (`core/ui/cameraPreviews.js/.css`, pure model in
   `cameraPreviewsModel.js`): under about 15 km across, ctOS-framed thumbnails
   (128 px desktop, 104 px phone) of the K (default 4, max 8) traffic cameras
   and webcams nearest the screen centre, each with a dashed leader line to its
   icon, the tracking overlay's two-digit id, a short name and the still's age.
   Re-chosen at most 4 times a second on rendered frames; postRender projects
   only those K points and moves the cards by transform. Stills via the layers'
   own still URLs (proxy image feeds) through `trafficcams/still.js`, at most
   once a minute per camera, only while the page is visible and the layer on;
   12 recent stills kept as blobs. Cards avoid each other, the icons and the
   selected target's label; a press selects the camera. Hidden in cockpit mode.
   Off in the car (driver distraction).
4. **Landmarks** (`core/layers/landmarks/parse.js`, `core/ui/poiTool.js`):
   TOOLS > LANDMARKS is now NEARBY: about 12 named OSM landmarks around the
   middle of the view (tourism attraction / museum / viewpoint / zoo /
   theme_park / aquarium; historic monument / castle / memorial / monastery /
   fort / palace / city_gate / ruins / archaeological_site / tower, without
   memorial plaques and Stolpersteine; man_made tower / lighthouse, minor masts
   only with a wiki link), Wikipedia / Wikidata ones first, then by distance,
   one per name. A row flies there framed for its kind (towers at their middle
   from further out, heading from where you are); SAVE adds it to MY PLACES
   (kind landmark). Scans when the section comes into sight and the view has
   moved, or on SCAN VIEW. The Landmarks layer uses the same query and the same
   tile loader (fetched once for both), Wikipedia-linked ones drawn larger. The
   card links Wikipedia, Wikidata, website and OSM. `core/search/pois.js` is
   untouched (offline search still uses it).

## Files

New: `core/layers/overpass/tiles.js` (+test), `core/layers/surveillance/{kinds,parse,select,source,fixtures}.js`
(+`surveillance.test.js`), `core/layers/signals/{parse,format,definition,mockSource,fixtures}.js`
(+`signals.test.js`), `core/layers/landmarks/{parse,fixtures}.js` (+`landmarks.test.js`),
`core/ui/cameraPreviews.js`, `core/ui/cameraPreviews.css`, `core/ui/cameraPreviewsModel.js` (+test).

Changed: surveillance `definition/format/cones/mockSource`, landmarks
`definition/format/mockSource`, `core/layers/overpass/parse.js` (shared
`osmLink`), `core/ui/poiTool.js` (rewritten), `shell-terminal/layers.js`.

Shared registries (one block each): `core/ui/glyphs.js` (OSM_SHAPES: cam-fixed,
cam-dome, cam-ptz, speedcam, redlight, acoustic, guardpost, signal),
`core/ui/palette.js` (`signals`), `core/ui/layerGlyphs.js` (`signals`;
surveillance tile now the ALPR glyph), `core/credits.js` (`signals` in the OSM
and Overpass credits, a DeFlock credit), `core/settings/store.js` (three keys).

Outside my folders, one line each: `core/layers/sdk/createLayer.js` (the
`def.select` hook, below), `core/scene/trackingOverlay.js` (`signals: 0.2` in
LAYER_WEIGHT, so traffic lights only take tracking boxes nothing else wants).

## main.js wiring

- Before `registrations`: one block defining `followFix()` and `osm` (anchor =
  your own position while following, from `window.argusCar.state()` in the car
  or `app.followingSelf?.()` + `app.selfPosition?.get?.()` elsewhere, else the
  ground at the middle of the view; the view bbox; per-layer scope; the shared
  landmarks tile loader; refresh / reload), plus a 4 s timer that re-picks the
  nearest surveillance after you moved 150 m while following (a following
  camera never raises moveEnd).
- Registrations: `surveillance` and `landmarks` now use the tiled sources;
  new `signals` entry after `bikeshare`.
- VIEW, after TRAFFIC CAMS: SURVEILLANCE (NEAREST 60 / ALL IN VIEW, RELOAD
  OSM) and CAMERA PREVIEWS (Show stills, 2/4/6/8). `app.cameraPreviews` exposes
  `setEnabled(on)`, `setCount(n)`.
- TOOLS: the old LANDMARKS block replaced by the NEARBY tool.
- Dev `window.__argus.cameraPreviews`.

## Settings keys

`survScope` ('nearest' | 'all', default 'nearest'), `camPreviews` (bool,
default true; ignored in the car, always off there), `camPreviewCount`
(2 | 4 | 6 | 8, default 4).

## Feeds

No new proxy feed: everything goes through the existing `overpass` feed
(`GET /interpreter?data=`). Query sizes per tile: surveillance `out center
6000` plus up to 500 relation devices (central Paris holds about 4,800
surveillance nodes per 0.1 degree tile), traffic lights `out 8000` (about 3,600
junction signals per tile in central Paris), landmarks `out tags center 1500`.
All tiled sources share one request queue (2 in flight). The proxy's governor
is 20 requests a minute: a first view of all three layers can exceed it; the
nearest tiles go first and failed tiles retry after 45 s.

## For other workers

- **A (Layer SDK tile cache)**: the definitions declare
  `fetch: { mode: 'viewport', tileCache: { tileDeg, ttlMs, maxTiles } }`
  (surveillance 0.1 deg / 12 h / 36, signals 0.1 / 24 h / 24, landmarks 0.1 /
  24 h / 40). Until your cache lands, the sources (`core/layers/overpass/tiles.js`)
  tile and keep data themselves; with your cache they receive one tile's bbox
  and fetch exactly that tile (same grid: tile `(ix, iy)` spans lon
  `-180 + ix*deg`, lat `-90 + iy*deg`). Two things your path needs:
  1. **`def.select(list)`**: I added this hook at the top of `ingest()` in
     createLayer.js (it picks the nearest 60 / all in view from everything held).
     Keep your merged-tiles list going through `ingest()` (or call `def.select`
     on it), or NEAREST breaks.
  2. View gating: my sources refuse views that are too wide (surveillance 160
     km, signals 22 km, landmarks 45 km, square root of the area); a one-tile
     query always passes, so the SDK needs its own limit on tiles per view.
     `source.reload()` drops my sources' tiles: RELOAD in your layer menu could
     call `ctx.source.reload?.()`.
- **D (car)**: please add `Layer("signals", R.string.layer_signals)` ("Traffic
  lights") to `CarLayers.ALL` in `android/.../car/MapScreen.kt` (I did not touch
  Kotlin). In the car, crossings are hidden, surveillance's nearest 60 count
  from the vehicle (`argusCar.state().following/fix`), camera previews are off.
  The car readout lists surveillance kinds by name ("RED-LIGHT CAMERA").
- **F (self position)**: if the phone shell gains a follow-me mode, expose
  `app.followingSelf()` returning true while the view follows you; NEAREST then
  counts from `app.selfPosition.get()`.
- **B (logs)**: tile failures go to `console.warn` and the layer's status note
  ("1 area failed"), never a popup.

## Tests run

- `node --test` core + mobile + terminal + car: 684 tests, 682 pass, the 2
  known failures only (satellites/propagate, scene/occlusion). New: 33 tests in
  tiles, surveillance, signals, landmarks, camera previews model (parsers
  against real trimmed Overpass fixtures, tag-to-kind mapping, nearest-n
  selection, tile fetch-once / failure backoff / progressive refresh / abort,
  card layout, still refresh timing).
- `node --test proxy/test/*.test.js`: 129/129.
- eslint (scratch config) and prettier: clean on every file I touched.
- Terminal: a script built the terminal layers in demo and with a fake proxy
  client; surveillance, signals and landmarks load, glyphs and cards right,
  signals appended last (no hotkey shift).

## Harness checks (stub Cesium, port 5205)

With the real San Francisco OSM sample ingested and eight real Caltrans D4
stills served locally:

- Desktop: the nearest 60 cluster with cones around the view centre, kind
  glyphs distinct (ALPR, dome, PTZ, fixed, acoustic, guard); the ALPR card with
  maker Flock Safety, SFPD, mount, facing, DeFlock source and an OSM link;
  traffic lights as signal heads; four preview cards with real stills, ids
  matching the tracking boxes, leader lines, the age in the corner, kept clear
  of the selected target's label. ALL IN VIEW: 1,352 cameras drawn (busy, which
  is why NEAREST is the default).
- VIEW tab: SURVEILLANCE and CAMERA PREVIEWS sections render in the ctOS style.
- TOOLS: LANDMARKS NEARBY lists 12 (dev mock) with two-line rows and SAVE.
- Mobile (`?shell=mobile`): previews at 104 px, inside the free area above the
  sheet.
- Car (`?shell=car`): no previews, no crossings, surveillance kinds in the
  readout, after merging 2231757 too.
- A glyph sheet at 48, 15 and 11 px: all eight new glyphs read apart.

## Not live-tested

- No request went through the Argus proxy to Overpass (Node's fetch cannot
  reach upstreams here). The query shapes were run with curl against the
  overpass.kumi.systems and maps.mail.ru mirrors (2026-10-09) and the fixtures
  are trimmed real answers; the combined surveillance query with the
  enforcement relations ran on maps.mail.ru (kumi answers 500 to relation bbox
  queries). overpass-api.de itself was not reachable from here.
- Real Cesium was not run: cones, glyph sizes, previews and the projection were
  checked on the stub only. The previews' "view across" uses
  `camera.pickEllipsoid` at the left and right edges.
- No webcam stills were tried in previews (the dev webcam mock has none);
  traffic-camera stills were real Caltrans images served locally.
