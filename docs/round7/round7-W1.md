# Round 7, W1: a ctOS vector basemap that stays sharp to street level

Owner (S25 Ultra, Indio, DARK basemap): "Zoomed in/close up of the map is not
detailed at all and makes it difficult to use as a map and shows no buildings and
roads look blurry"; "when enabling street names the overlays are yellow instead of
ctos style"; "biggest issue is quality when zoomed in or just close".

## Why it was blurry

- DARK was Esri's World Dark Gray Canvas, a raster that stops at about zoom 16.
  Closer in, Cesium stretched its last tiles 4 to 8 times: soft roads, no
  buildings (the canvas never draws them).
- Street names were Esri's reference overlay, drawn in its own yellow; no tint can
  turn that into ctOS white on a keyline.
- CARTO's dark tiles (the obvious swap) now answer "API KEY REQUIRED" from this
  container, so a raster fix was not available keyless.
- Render resolution was misread: Cesium multiplies `devicePixelRatio` by
  `resolutionScale`, so the balanced profile's 1.25 rendered a 3.5x phone at about
  4.4x (more than the panel), which costs heat without adding detail, while the
  map tiles themselves were the soft part.

## What DARK is now

- OpenStreetMap vector tiles from OpenFreeMap (keyless, OpenMapTiles schema,
  source data to zoom 14), through two pinned proxy feeds, drawn in the ctOS
  palette: near-black ground (`#121212`), dark teal water, building footprints
  with a hairline edge, roads at their real width for the zoom and latitude with
  hairline casings (motorway brightest, service roads faintest), dashed paths and
  rail.
- Drawn at 512 px for each 256 px Cesium tile and offered to zoom 21: past zoom 14
  the source tile is drawn larger (vector, so still sharp), never upsampled.
- Decoding and drawing run in a module worker on an OffscreenCanvas; without
  worker or OffscreenCanvas support the same engine runs on the main thread.
  Decoded tiles and label placements are kept in small LRU caches; one request
  per source tile however many output tiles it feeds.
- Labels (VIEW > LABELS) come from the same tiles as transparent overlays over any
  basemap: white monospace on a dark keyline. Names are placed once per source
  tile and zoom with collision boxes, so a name crossing two map tiles is drawn
  whole in both; a name that collides at the middle of its road tries a quarter
  and three quarters along. Road numbers in ctOS brackets (zoom 15 and below),
  POIs from zoom 17, house numbers from zoom 18.
- Without the proxy (or when the tiles fail), DARK falls back to Esri's canvas and
  the Esri label overlays are toned to ctOS grays (desaturated, never yellow); the
  failure goes to SETUP > LOGS as DARK MAP UNAVAILABLE.
- The globe's own base colour is the ctOS ground, so no white shows past the
  map's coverage (a white polar cap showed on real Cesium).
- Render resolution is stated as rendered pixels per CSS pixel: at most 2x by
  default on phones and desktops (the map is drawn at 2x), 1.5x on the minimal
  tier. SETUP > resolution offers 1x, 1.5x, 2x, 2.5x and Max (native).

## Files

- New: `core/scene/vector/mvt.js` (Mapbox Vector Tile 2.1 decoder, only the layers
  and properties asked for), `render.js` (style and drawing: roads, water,
  buildings, labels, placement), `tiles.js` (engine: fetch, decode, caches,
  render), `worker.js`, `client.js` (worker or main thread; TileJSON through the
  proxy for the dated tile set), `provider.js` (the Cesium ImageryProvider),
  `vector.test.js` (8 tests with a tiny MVT encoder).
- `core/scene/imagery.js` (`setVectorBasemap`, `vectorProvider`, `reload`),
  `core/scene/labels.js` (vector overlays, Esri tone, `refresh`),
  `core/scene/createViewer.js` (base colour), `core/capability/profile.js`
  (`resolutionScaleFor`), `core/settings/store.js` and `core/ui/settingsPanel.js`
  (resolution choices), `core/credits.js` (OpenFreeMap), `main.js` (wiring).
- Proxy: `proxy/feeds/basemap.js` (`openfreemap`: the TileJSON only;
  `openfreemap-tiles`: `/planet/<date>_<time>_pt/<z 0-14>/<x>/<y>.pbf` only, 8 at a
  time, 900 a minute, cached 7 days and served stale up to 30 when the upstream
  fails, 3,000 entries or 48 MB), `proxy/test/basemapFeeds.test.js`.

## Checked

- Unit: the decoder on a hand-encoded tile, geometry commands and zigzag, source
  tile and offset for overzoomed tiles, road widths, label placement across tile
  edges and at crossings, the engine's 404 handling.
- Live, through the real proxy from this container: the TileJSON answered a dated
  tile set; the Indio zoom 14 tile decoded in about 16 ms.
- Real CesiumJS 1.140 in headless Chromium (software WebGL) with the real proxy:
  Indio at 300 to 700 m shows sharp roads, buildings and white ctOS street names;
  this is where the per-tile vertical flip was found (ImageBitmaps are now sent
  pre-flipped, which Cesium expects) and the white polar cap.

## Not verified

- Not on the phone's GPU or in the Android WebView (OffscreenCanvas in a worker is
  supported there per the platform, not checked on the device).
- OpenFreeMap is a donation-run public service with no stated rate limit; the
  proxy's cache and governor keep a session polite. If it goes away, DARK falls
  back to Esri automatically.
