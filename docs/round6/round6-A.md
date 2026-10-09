# Round 6, worker A: merge nearby, tap picking, gestures, fetch once

> Integration note: the surveillance and landmarks conversions in section 4 were superseded when this work was merged with E1's. Those layers (and traffic lights) keep E1's own 0.1 degree, nearest-first tiling in `core/layers/overpass/tiles.js` and RELOAD reaches it as `query.reload`; the SDK tile cache serves data centres, installations and dams. A view up to 16 times the tile budget now loads its nearest tiles instead of nothing. See Phase I in `docs/AUDIT.md`.

Scope: the Layer SDK (core/layers/sdk), the interaction spine
(core/interaction), camera controls (core/scene/cameraControls.js), the layer
menu, plus small blocks in glyphs.js, settings/store.js, layerManager.js and
main.js. Everything applies to every shell: desktop, Linux, the phone and the
car (shell-car boots through main.js).

## What the owner asked, and what changed

| Owner's words                                                                                | What it is now                                                                                                                                           |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Lags a lot when zoomed out ... would be cool to default to merge"                           | MERGE NEARBY, on by default: point and billboard layers group in screen space while the camera is above 3 km                                             |
| "make pinching zoom in better too. Double tapping will zoom in as well and 3 taps zooms out" | a pinch follows the fingers; double tap / click zooms in x2 about the point, triple tap / click zooms out x2; trackpad pinch zooms the map, not the page |
| "it just focuses on the storm" / "taps ... stuff through the earth"                          | contacts beat lines beat areas under a tap; a contact behind the planet never counts                                                                     |
| "shouldnt ... ALPR readers be fetched once and thats it for a while or manually reloaded?"   | static layers are fetched once per fixed tile and kept (12 h / 24 h in memory); RELOAD beside the layer's row                                            |

## 1. Merge nearby (clustering)

Files: `core/layers/sdk/cluster.js` (pure, tested), `core/layers/sdk/createLayer.js`,
`core/ui/glyphs.js` (`clusterGlyph`), `main.js` (switch, policy, pin, hold).

- Screen-space grid (52 px cells with a mouse, 60 px on touch). A cell with two
  or more contacts becomes one marker; its members get `billboard.show = false`
  (the GPU win), `rec.visible = false` (so `forEachVisible`, the tracking
  overlay, model LOD and picking never see them).
- The grid is anchored to a world point shared by every layer of the scene, so
  a pan slides the groups with the globe instead of reshuffling them, and all
  layers cut the screen along the same lines.
- Marker: ctOS bracket box with the count (exact below 100, then `300+`,
  `2K+`), a second frame peeking out behind (a stack), drawn white and tinted
  with the layer's ink (`LAYER_INK` by the manager key). Height steps 24 / 28 /
  32 / 36 px with the count. Groups of different layers in the same cell fan
  out (slots in the order the layers started) instead of stacking.
- Tapping a marker flies to fit its members (`camera.fitBounds`, keeps the
  heading, at most a 40 degree tilt); a group stacked on one spot gets a
  minimum box that lands under 3 km, where everything is drawn apart.
- Recluster only when the camera moved or turned, records changed, or the
  policy changed; at most 4 Hz, movers under a still camera once a second, with
  a trailing pass when the camera settles. Per pass: one view-projection
  matrix, a few multiplies per contact (falls back to
  `SceneTransforms.worldToWindowCoordinates` when the camera has no matrices,
  e.g. the harness stub). Typed arrays, pooled markers: no per-contact
  allocation. The pure grid does 10k contacts in a couple of milliseconds
  (tested).
- Never merged: the selected target (`policy.pinned`, set from the tracker),
  contacts drawn as 3D models (suppressed), everything while riding along
  (cockpit `hold`), everything below 3 km camera height, and layers with
  `def.cluster === false` (BGP pulses).
- Setting key `merge` (default `true`) in `core/settings/store.js`; VIEW >
  CONTACTS > MERGE NEARBY switch (follows a settings reset or import).

## 2. Tap picking

Files: `core/interaction/pickPriority.js` (pure, tested), `core/interaction/picker.js`,
`core/interaction/centerPicker.js`.

- Every drill-pick result is classed: contact (billboard, point, label, model,
  cluster marker, layer target), line (polyline / path Entity), area (polygon,
  ellipse, corridor, ... Entity). Contacts win over lines over areas; within a
  class the drill order (nearest the tap) decides. An area is chosen only when
  nothing else is under the finger.
- A glyph drawn without depth test whose position is behind the planet
  (EllipsoidalOccluder from the camera) is rejected.
- Touch drill box stays 44 px (22 px radius); 12 results drilled.
- Point-at-sky (centre picker) uses the same priority.
- Cesium's own LEFT_CLICK / LEFT_DOUBLE_CLICK viewer handlers are removed
  (`cameraInput.js`): every click was picking the scene a second time (and
  asking imagery providers for features), and a double click locked the camera
  onto whatever Entity was under it.

## 3. Gestures (Pointer Events only)

Files: `core/interaction/gestures.js` (pure, tested: `createTapSequencer`,
`pinchZoomFactor`, `wheelPinchFactor`), `core/interaction/picker.js`,
`core/interaction/cameraInput.js` (new), `core/scene/cameraControls.js`
(`zoomAt`, `fitBounds`).

- One tap selects at once (no wait). Two taps within 300 ms and 40 px (12 px
  with a mouse) zoom in x2 about the tapped point: the camera slides along the
  ray through that pixel, so the point stays under the finger, eased over
  320 ms on rAF, cancelled by the next press. Three taps zoom out: the
  triple undoes its double's zoom first, so it ends x2 out from where the
  gesture began (one smooth reversal, no extra delay on the double tap).
- A tap on empty map deselects only after the double-tap window, so a double
  tap on the map keeps the current target.
- A pinch or a two-finger tap never selects (pointers tracked by id). Right /
  middle button presses never select or zoom.
- Pinch: while two touches are down Cesium's `zoomFactor` is set to
  4 x canvas height / finger spacing, which makes each frame move the camera by
  exactly the change in spacing (Cesium's default moved about a third of it, the
  "laggy" feel), then back to 5 for the wheel. Measured on the harness: 33 at
  110 px spacing, 17 at 210 px, 5 after.
- Trackpad pinch (ctrl+wheel) zooms about the cursor by the reported scale;
  before, Cesium ignored ctrl+wheel and the browser zoomed the page.
- Zoom envelope: 20 m from the ground to 45,000 km.
- Taps that the page synthesises (Android Auto via `argusCar.tap`) are always
  single taps: the car has its own zoom gesture (`argusCar.zoom`), and two car
  taps never zoom. `argusCar` API untouched.

## 4. Fetch once: the static-layer tile cache

Files: `core/layers/sdk/tileCache.js` (pure, tested), `core/layers/sdk/createLayer.js`,
`core/ui/layerMenu.js/.css` (RELOAD), `core/layers/overpass/client.js`
(`query.reload` skips its memo), the converted definitions and their dev mocks.

Contract (as in the BRIEF): `fetch: { mode: 'viewport', tileCache: { tileDeg,
ttlMs, maxTiles } }`. Optional extras: `maxView` (default 16), `concurrency`
(default 2), `retryMs` (default 60 s).

- The source is called once per tile: `query.bbox` = the tile's box,
  `query.tile` = `'<tileDeg>/<x>/<y>'`, `query.reload = true` after RELOAD.
- Each tile's raw answer and normalized list are kept for `ttlMs` (least
  recently used out past `maxTiles`, which is raised to at least `maxView + 8`
  so one view's tiles never evict each other). Records of all cached tiles are
  merged (deduped by id, nearest the view first when over `maxEntities`) and go
  through `ingest()` (so a `def.select` hook in ingest still applies; with
  `def.select` the records are re-ingested on every camera stop).
- A cached tile is never fetched again until it expires or RELOAD. Expired
  tiles stay drawn until their new answer arrives. Failed tiles rest
  `retryMs`; a 429 / 503 empties the queue and the layer rests 30 s.
- Nearest tiles first; at most `concurrency` per layer and 3 across all tile
  layers of the page (the Overpass budget is shared).
- A view needing more than `maxView` tiles fetches nothing new ("zoom in to
  load"); cached tiles still draw.
- A tile already in flight is never fetched twice, and a newer camera stop
  does not cancel it (it finishes into the cache).
- The status note is the SDK's (`zoom in to load`, `loading N tiles`,
  `N tiles failed: ...`); `statusNote` is not called for a tile layer. Status
  objects carry `pending` (tiles queued or in flight).
- Merged with 2231757: tile layers record the view they asked for, so the
  same-view skip (4 %) and the 4 s drift refetch (cameras that never settle:
  the car) apply to them too.
- `layer.reload()` (RELOAD): every cached tile counts as expired, the view is
  asked again with `query.reload`; `layer.reloadable` is true for tile layers,
  viewport layers and polls of 5 minutes or more.

Converted: surveillance (0.5 degree tiles, 12 h; only the fetch block of
`surveillance/definition.js` changed), landmarks (0.5, 12 h), data centres
(2 degrees, 24 h), installations (1, 24 h), dams (1, 24 h). Their dead
`statusNote`s were removed (except surveillance, E1's). Not converted:
webcams (Windy still links expire after ~10 min, and the source thins per
view), traffic cams (whole-network catalogues capped per view: tiling would
change the caps), cables (one global file a day already). They get RELOAD as
long polls.

RELOAD in the layer menu: a 32 px framed square with a square-loop arrow
beside the row of an enabled reloadable layer, blinking while the reload is
pending. It sits next to the row button (not inside it), so the car's
`[data-layer]` row reconciliation is unchanged.

## main.js wiring (all in existing blocks)

1. `setupScene`, right after `createCameraControls`: imports
   `core/interaction/cameraInput.js` and `core/layers/sdk/cluster.js`, calls
   `tuneCameraInput(app.viewer, camera)`, creates the scene's cluster policy
   `merge` and sets it from the `merge` setting.
2. VIEW menu, after TRACKING: a `CONTACTS` section with the MERGE NEARBY
   switch (writes the setting; a settings subscription keeps policy and switch
   in step).
3. `attachTracking` gets `camera` and `merge`: the cockpit's onEnter/onExit
   hold merging; the tracker's onChange pins the target; `createPicker` gets
   `intercept: interceptTap`, `onZoom` -> `camera.zoomAt`, and a cluster tap
   -> `camera.fitBounds(target.bounds())`.

`core/scene/layerManager.js`: passes `key` (the manager key) into the layer
ctx (ink and log source).

## Settings keys

`merge`: `true` (default) / `false`.

## Tests, lint, format

- `node --test` over core, shell-mobile, shell-terminal, shell-car: see the
  final report for the count; only the two known failures
  (satellites/propagate, scene/occlusion: missing packages).
- New tests: `core/layers/sdk/cluster.test.js`, `core/layers/sdk/tileCache.test.js`,
  `core/interaction/pickPriority.test.js`; extended `gestures.test.js`,
  `settings/store.test.js`, `overpass/client.test.js`.
- eslint (scratch config) and prettier clean on every file touched.

## Harness (stub Cesium, headless Chromium)

Scripts in the scratchpad (`A/perf.cjs`, `interact.cjs`, `mobile.cjs`,
`car.cjs`, `slots.cjs`); screenshots looked at for every layout.

Measurements: every layer on (dev mocks) plus 11,000 synthetic contacts in
three static layers, whole-Earth view, same build, same load, MERGE NEARBY
on vs off (off is what main did):

| Layout                        | Billboards drawn  | Render, still camera | Render, panning |
| ----------------------------- | ----------------- | -------------------- | --------------- |
| Desktop 1600x900, merge off   | 4,376 of 11,384   | 32.8 ms              | 33.7 ms         |
| Desktop 1600x900, merge on    | 578 of 11,849     | 7.0 ms               | 8.2 ms          |
| Phone 412x915, merge off      | 4,507 of 11,516   | 43.3 ms              | 41.2 ms         |
| Phone 412x915, merge on       | 235 of 11,705     | 5.1 ms               | 7.9 ms          |
| Desktop, mocks only, off / on | 331 / 143 of ~400 | 4.2 / 4.3 ms         | 4.7 / 4.2 ms    |

(The stub draws every shown billboard on a 2D canvas, so "drawn" is the cost
that scales; the totals include the pooled cluster markers. The earlier main
build, before this round, measured 4,379 drawn and 28.8 / 33.0 ms on the
desktop at a lighter machine load.)

Checks that pass on the harness:

- Desktop: tiles cached (pan 2 degrees away and back: no new request), whole
  country view says "zoom in to load", RELOAD refetches the view's 12 tiles,
  groups dissolve under 3 km, the switch turns groups off and on, a click on a
  group flies from 400 km to about 30 km and selects nothing, double click
  halves the height about the point (400 -> 200 km), triple click doubles it
  (200 -> 400 km), pick priority (a contact under a storm polygon wins; a
  polygon alone wins; a contact behind the planet never does), a click on a
  contact selects within 60 ms, a double click on empty map keeps the target, a
  single click on empty map deselects after the double-tap window.
- Phone (touch, dpr 2): a tap 6 px off a group's marker flies in, double tap
  x2 in, triple tap x2 out, two touch points set the zoom factor from their
  spacing (5 -> 33 at 110 px -> 17 at 210 px -> 5 after) and never select,
  RELOAD square beside the enabled SURVEILLANCE row (32 x 40 px).
- Car (1536x576, dpr 1.25, `?shell=car`): surveillance tiles follow a
  simulated drive (drift refetch), two quick `argusCar.tap` calls never zoom
  and leave the follow state alone, `argusCar.state()` unchanged, groups appear
  after zooming the car view out (55 km).
- Shared tile slots: two tile layers with slow sources never had more than 3
  requests in flight together; a 429 stopped the queue after the 2 requests
  already in flight.

## Not verified here

- Real Cesium: the fast projection path (`camera.viewMatrix` x
  `frustum.projectionMatrix`), the pinch zoom-factor feel, `globe.pick` for
  the tap point, `flyToBoundingSphere` for a group, the removed viewer click
  handlers and `pixelOffset` picking ran only against the stub (which has no
  matrices, no real pinch, and picks billboards at their un-offset position).
  Cesium 1.140 sources were read for the zoom formula, inertia and the
  multi-object pick order.
- No live Overpass: the tile cache ran against the dev mocks and synthetic
  sources only.

## For other workers

- E1: your sources get `query.tile` and `query.bbox` of one SDK tile per
  call, and `query.reload` after RELOAD; please skip your own memo when
  `query.reload` is set. One SDK tile should be one upstream request: if your
  source splits a bbox into 0.1 degree tiles, either set
  `surveillance.fetch.tileCache.tileDeg` to your tile size (and lower
  `maxView` accordingly, it counts requests) or batch the missing sub-tiles
  into one query. The surveillance fetch block is the only thing I changed in
  `surveillance/definition.js`; take yours where they differ.
- B: tile fetches are not cancelled by newer camera stops, nor by the layer
  stopping or the page hiding (they finish into the cache); only a destroyed
  layer aborts. RELOAD reaches the proxy as a normal request: if the proxy
  should skip its own Overpass cache on RELOAD, it needs a signal I did not
  add (a custom header would trigger CORS preflights cross-origin).
- D (car): `argusCar.tap` stays a single tap (synthetic pointer events never
  form a double tap); merge nearby applies in the car above 3 km camera
  height; contacts hidden in a group are not in the overlay summary the car's
  readout lists.
- Logs: tile failures call `ctx.log?.({ level, source, title, body })` and
  `console.warn`; layerManager does not pass a `log` yet (B can wire
  `app.logs.add` there). No notifier popups were added.
