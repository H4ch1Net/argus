# Round 6, worker E2: simulated traffic, street photos, Shodan, TomTom, smooth motion

Branch `worktree-agent-a7980965228c9d5c5`, based on main `fece91d`, with the
integration commit `2231757` merged in (no conflicts).

## What I built

### 1. Simulated traffic (`simtraffic`, "Traffic (simulated)")

A SIMULATED fleet on real OSM roads, only below 8 km camera height, on every
shell (desktop, phone, Android Auto through `shell-car`, the terminal map).

- Roads: Overpass ways with geometry through the existing `overpass` feed, one
  query per tile, classes by height (below 1.5 km motorway..residential in
  0.01 degree tiles; to 4 km down to tertiary in 0.02; to 8 km down to
  secondary in 0.04), at most 4 / 6 / 9 tiles per view (minimal / balanced /
  full), nearest first, one at a time, cached 30 minutes per tile. Ways are
  split at shared vertices into a routable graph (`roads.js buildNetwork`).
- Simulation (`sim.js`, pure, seeded mulberry32): lanes per direction (lanes
  tag, else class default; one-way rules incl. implied motorway/roundabout),
  the Intelligent Driver Model for car following (also across a junction: the
  next road is chosen on lane entry), turn slow-downs, right- or left-hand
  traffic by a rough region lookup, fleet sized by lane-km in view (9 per
  lane-km, more on congested roads), capped 150 / 400 / 1500 by tier (the car
  runs minimal). Typed arrays sized once: a step allocates nothing.
- Speeds: free-flow = TomTom's measured free-flow speed when matched, else
  `maxspeed`, else the class default; times the road's congestion ratio
  (TomTom current / free-flow). Congestion from TomTom Flow Segment Data at a
  budgeted handful of points per view (3 / 5 / 8 by tier, bigger roads first,
  300 m apart), each segment's returned geometry matched back onto the OSM
  edges it runs along (midpoint within 18 m and parallel), roads of the same
  class group inherit the median ratio (marked inferred). Without a TomTom key
  everything runs free-flow and the layer note says
  `SIMULATED, free-flow (no TomTom key)`.
- Rendering (`renderer.js`, the SDK's `field` renderType): one
  BillboardCollection (heading-up `vehicle` glyph, amber when crawling) written
  on a fleet tick of 12 Hz (15 on full) through `core/scene/renderMode.js`
  acquire/release, only while on, visible and low; congested roads as ONE
  batched ground polyline primitive via the existing
  `core/layers/surveillance/groundBatch.js` (muted ctOS green / amber / red,
  measured strong, inferred faint, small roads only when measured). Terrain
  heights sampled per road vertex in chunks (skipped on the ellipsoid).
  Vehicles are not contacts: never picked (a tap hides the fleet for the one
  task the drill pick runs, so cars never hide a real contact).
- Status note examples: `412 veh, SIMULATED, TomTom flow at 6 pts (31 roads)`,
  `below 8 km only`, `DEMO roads, simulated, demo congestion` (dev mock: a
  procedural street grid anywhere, demo congestion).

### 2. Street photos (`streetphotos`, "Street photos") and STREET PHOTO

- Mapillary API v4 `/images?bbox&fields&limit` through a new pinned feed
  `mapillary` (MAPILLARY_TOKEN injected as `Authorization: OAuth <token>`,
  never in a URL), only for a zoomed-in view: 0.01 degree tiles, at most 6 per
  view, cached 30 min here and at the proxy. Fields:
  `id,captured_at,compass_angle,geometry,thumb_256_url,thumb_1024_url,is_pano`
  (no creator fields: the card never names who took a photo).
- Thumbnails rewritten onto the image-only feed `mapillary-img`
  (`scontent.xx.fbcdn.net`, `/m1/v/tN/<token>` paths and the CDN's signing
  params only; `MAPILLARY_IMAGE_URL` can name another edge host). The browser
  never loads a third-party host.
- Pins: a new `photo` glyph (camera body with a direction tick) turned to the
  compass angle. Card: the photo, capture time, facing, kind (360 panorama),
  CC BY-SA 4.0 credit and an "Open on Mapillary" link.
- STREET PHOTO action on the target card of any place on the ground (not on
  country centroids, geolocated IPs, collector cities, storm centres, orbits):
  the nearest image within 400 m (its tile, then neighbours nearest first);
  selected in the layer when it holds it, else placed through the OSINT
  plotter and selected. "none within 400 m" shows as a card row, no popup.
- Registered with `requires: 'mapillary'` (hidden without a token); the dev
  mock draws demo capture sequences labelled DEMO.

### 3. Shodan (audit, fixes, InternetDB, new features)

Fixed:

- The default query `product:Apache httpd` was unquoted (Shodan reads it as
  `product:Apache` AND the word `httpd`): now `product:"Apache httpd"`.
- The feed had no cache at all (every layer start was a request) and its
  `allowPaths` were unanchored (`/shodan/host/count...` prefixes) with no
  query pin: anyone with the proxy could run any free-text search (costing
  credits). Now the feed (moved to `proxy/feeds/exposure.js`) pins paths
  exactly and pins the query to the curated snapshot strings (optionally
  narrowed to one country), the two facet strings, one minified first page for
  the sample, or nothing for a host lookup; cached 12 h, 7 days stale.
- The layer had no `requires`: without a key it showed a dead error chip.
  Now hidden until the proxy has SHODAN_API_KEY.
- `core/interaction/targetExtras.js rows()` threw for OSINT plotter records
  (no normalized record: `n.id` of undefined), breaking selection of plotted
  query results; guarded.

Added:

- Curated snapshots (`core/layers/shodan/snapshots.js`): web (Apache), RDP,
  VNC, Telnet, SMB, databases, MQTT, Modbus, S7, BACnet. Infrastructure only,
  never cameras or people. VIEW > SHODAN picks one (setting `shodanSnapshot`).
- Country cards: share of the snapshot, rank, and (on tap, credit-free count
  narrowed to the country, cached) top ports / operators / products.
- Opt-in host sample (VIEW > SHODAN > Host sample, setting `shodanSample`):
  one minified page of `/host/search` for the snapshot (one query credit,
  cached 12 h, the governor's 90/month budget still applies), hosts placed at
  Shodan's geolocation; they appear in CONTACTS as hosts near the view, and
  their cards get InternetDB rows.
- InternetDB (`internetdb` feed, keyless, live-tested, cached a day): in the
  OSINT console (`query` adds an "Exposure (InternetDB)" section for IPs and
  domains; `correlate` uses InternetDB first and the keyed Shodan host lookup
  for the operator / as a fallback), in `argus query|correlate`, and as card
  rows for any record naming an IP (`meta.ip`). BGP cards get LOOK UP AS
  (correlates the origin AS through RIPEstat, plots and selects it). The
  threat layer is demo-only with no IPs, so it gets nothing.
- Shodan joins the Internet preset (skipped where it is not registered).

### 4. TomTom

- `tomtom-flowseg` feed: Flow Segment Data v4, `absolute` style, zooms
  10/12/14/16, JSON, a point at 5 decimals, `unit=KMPH`; 450 requests a day
  (with incidents' 2,000 this stays under the free 2,500), 30 a minute, cached
  2 min, 10 min stale. Used by the simulated traffic and:
- FLOW readout (VIEW > ROAD FLOW, setting `flowReadout`, off by default): the
  live speed on the road at the middle of the view, `34 / 52 KM/H (65%)`
  coloured by level, in the bottom strip on desktop and the intel pane on the
  phone; one request when the view settles somewhere new below 25 km, at most
  every 15 s, reused for 5 min within 30 m.
- `argus flow <place|lat,lon>` in the terminal.

### 5. Smooth motion

Found: movers interpolated only between the LAST TWO fixes with ingest-time
stamps and a lag of exactly one interval. So (a) a camera-move refetch 5 s
into an interval made every contact jump back to the previous fix, (b) a late
poll made contacts stop at their last fix and then jump forward, (c) a poll
that returned the same report (transit agencies update every 15 to 30 s, the
proxy caches adsb.lol) stalled the contact for an interval and then ran it at
double speed, (d) ships (lag 5 s, reports every 2 to 10 s) jumped on every
report. The test `core/layers/sdk/motion.test.js` reproduces it: the old path
on a choppy feed stops (0 m/s frames) and jumps (> 3x speed).

Fixed in the SDK (`createLayer.js`, helpers in `interpolate.js`):
bracketing across all retained fixes; optional `def.fixTime` (source report
time) aligned to the local clock by the batch's median age (a repeated report
replaces, an older one is ignored); dead reckoning along the velocity past the
newest fix (and before the first, so a new contact moves at once) for up to
`extrapolateMs`; a 700 ms ease of the drawn position (snaps over 3 km). Flights
and military use report times (OpenSky time_position, adsb.lol now - seen_pos,
added to `parseAdsb`), lag 18 s; transit uses the GTFS-RT timestamp, lag 25 s,
reckons 8 s at most; ships reckon on SOG/COG up to 60 s, lag 8 s. The terminal
engine brackets and reckons the same way. Harness (stub, dev mocks): per-tick
speed of every flight, military and ship track stays within about 3 % of its
median (p02 to p98); the only outlier is the flights mock's own wrap-around
teleport at the view edge.

## Files

New: `core/layers/simtraffic/{roads,sim,flow,source,format,view,renderer,
definition,mockSource,driver}.js`, `simtraffic.test.js`,
`fixtures/overpass-sf.json` (real Overpass answer, SF, 2026-10-09, trimmed);
`core/layers/streetphotos/{parse,format,source,definition,mockSource,extras}.js`,
`streetphotos.test.js`; `core/layers/shodan/{snapshots,source,extras,controls}.js`,
`shodan.test.js`; `core/osint/{internetdb,cardExtras}.js`, `internetdb.test.js`,
`fixtures/internetdb.json` (real answers: 8.8.8.8, 1.1.1.1, 45.33.32.156, an
unknown IP); `core/ui/{roadFlow,cardPlugins}.js`, `roadFlow.test.js`;
`core/layers/sdk/motion.test.js`; `proxy/feeds/{streets,exposure}.js`,
`proxy/test/{streetFeeds,exposureFeeds}.test.js`;
`shell-terminal/cliIntel.test.js`.

Changed: shodan `parse/format/definition/mockSource`, osint
`lookup/correlate/plotter/mockLookup`, `core/layers/sdk/{createLayer,
interpolate,ringBuffer}.js`, flights `parse/definition`, military/transit/ships
definitions (+ `shipVelocity` in ships/format), `shell-terminal/{engine,layers,
cli}.js`, `bin/argus.js` (help), `core/interaction/targetExtras.js`
(plugins + the guard), `core/credits.js`, `core/ui/{glyphs,palette,
layerGlyphs}.js`, `core/settings/store.js`, `core/presets.js(+test)`,
`proxy/feeds.js`, `.env.example`, `main.js`, and (one line each, flagged
below) `shell-car/model.js`, `android/.../car/MapScreen.kt`,
`android/.../values/strings.xml`.

## main.js changes (exactly)

1. Registrations: two new entries after `borderwaits` (`simtraffic`, with a
   dev-only `window.__argus.simTraffic = model` for the console; and
   `streetphotos`, `requires: 'mapillary'`). The `shodan` entry now has
   `requires: 'shodan'` and builds `createShodanSource` with the two settings.
2. Before `createTargetExtras`: `createCardPlugins(...)` (core/ui/cardPlugins.js)
   and `plugins: cardPlugins` passed to `createTargetExtras`.
3. After the TRAFFIC CAMS section: ROAD FLOW (`mountRoadFlow`, only with
   `keyed('tomtom-flowseg')`) and SHODAN (`createShodanSection`, with
   `keyed('shodan')` or a dev session without a proxy).

## Settings keys (core/settings/store.js, one block)

`shodanSnapshot` (web | rdp | vnc | telnet | smb | databases | mqtt | modbus |
s7 | bacnet), `shodanSample` (bool, off), `flowReadout` (bool, off).

## Feeds and keys

| feed                     | upstream                                    | key                            | budget / cache                                 |
| ------------------------ | ------------------------------------------- | ------------------------------ | ---------------------------------------------- |
| `tomtom-flowseg`         | api.tomtom.com/traffic/services/4           | TOMTOM_API_KEY (query)         | 450/day, 30/min; 2 min, 10 min stale           |
| `mapillary`              | graph.mapillary.com/images                  | MAPILLARY_TOKEN (OAuth header) | 30/min, 5000/day; 30 min, 24 h stale           |
| `mapillary-img`          | scontent.xx.fbcdn.net (MAPILLARY_IMAGE_URL) | none, image-only               | 120/min; 6 h                                   |
| `internetdb`             | internetdb.shodan.io/{ip}                   | none                           | 60/min; 24 h, 7 days stale                     |
| `shodan` (moved, pinned) | api.shodan.io                               | SHODAN_API_KEY                 | 30/min, 90 credits/30 days; 12 h, 7 days stale |

Credits added in one block (`tomtom-flow-segments`, `mapillary`, `internetdb`);
`simtraffic` added to the OSM layers list. Terminal: `ARGUS_SHODAN_SNAPSHOT`.

## Terminal

Map layers: `simtraffic` (the same model, a time-driven driver,
`core/layers/simtraffic/driver.js`; active at the terminal's closest zooms),
`streetphotos` (loads the tiles around the middle at the closest zoom),
`shodan` (snapshot + host points). Commands: `argus flow <place|lat,lon>`,
`argus shodan [--snapshot ID|list] [--country CC] [--limit N]`,
`argus photo <place|lat,lon>`; `argus query` / `correlate` print InternetDB.

## Tests and checks

- `node --test` core + shells: 706 tests, 704 pass, the 2 known failures
  (satellites/propagate, scene/occlusion: missing packages). Proxy: 139/139.
- eslint (scratchpad config) clean on core, shell-terminal, bin, proxy, main.js;
  `prettier --check .` clean.
- Real fixtures: Overpass roads (maps.mail.ru mirror) for parsing, the graph,
  the simulation, flow matching; InternetDB answers. TomTom and Mapillary from
  their documented shapes only.
- Harness (stub Cesium, port 5206):
  - desktop 1.2 km: 400 vehicles on the demo grid (balanced tier), two-way
    offsets visible, measured roads tinted; 5 km: city band, trunk roads red;
    12 km: `below 8 km only`, no frames requested (0 fps from the layer).
  - mobile (`?shell=mobile`) 900 m: 400 vehicles, two lanes each way.
  - car (`?shell=car`, follow view ~6.5 km): city band, 150 vehicles, tinted
    roads, 12 Hz tick.
  - Fleet tick cost (step + write, stub): minimal 150 veh 0.19 ms avg; balanced
    400 veh 0.38 ms; full 1500 veh 0.55 ms (max 3.5 / 7.7 / 10.4 ms, the max
    being the tick that rebuilt the network). Page script time with the layer
    on vs off: +19 / +32 / +71 ms per second, which includes the stub drawing
    every billboard on a 2D canvas in JS (real Cesium draws on the GPU).
    Node benchmark: 1183 vehicles on 625 edges step + positions 0.21 ms.
  - Cards (desktop and mobile): street photo pin and card; STREET PHOTO from a
    bikeshare station (found / "none within 400 m"); Shodan DE card with
    facets; host sample host card; VIEW > SHODAN section. All ctOS styled.
  - Terminal frame (`--demo`, closest zoom): sim vehicles on the grid, photo
    pins.

## Not live-tested

- TomTom Flow Segment Data (no key): request shape and response per TomTom's
  v4 documentation; which zoom best matches small roads is a guess (12 / 14 /
  16 by class); the matcher is geometry-based so a snap to a neighbouring road
  still colours the right road.
- Mapillary (no token): request and response per the API v4 docs; whether the
  generic `scontent.xx.fbcdn.net` host serves thumbnails signed for a regional
  edge is untested (`MAPILLARY_IMAGE_URL` is the escape hatch; the card still
  links the image on mapillary.com either way).
- Shodan with a key: `/host/count` facets as before; the host sample's match
  shape per the docs; `country:200` facet size kept from the previous code.
- Real Cesium: the renderer, ground batch and billboards were only run on the
  harness stub; GroundPolylinePrimitive per-instance colours, billboard
  alignedAxis/rotation and terrain heights follow existing patterns in the
  repo (groundBatch.js, renderers.js) but were not seen on a GPU.

## For other workers

- A (SDK): `createLayer.js` changed in `geodeticNow`, `positionOf`, `upsert`,
  `ingest`, `pushIngest`, the tick (`positionOf(rec, rec.world, true)`) and a
  `defaultVelocity` helper at the end; `ringBuffer.first()` added. New
  optional def keys: `fixTime`, `velocityOf`, `extrapolateMs`, `smoothMs`.
  Nothing touches the poll / tile-cache path.
- B (logs): failures go to `console.warn` and the layer's `onStatus`; the
  simulated traffic reports `state: 'error'` only when its roads fail and it
  has none.
- D (car): I added `simtraffic` to `CarLayers.ALL` (after `chp`), its string
  `layer_simtraffic`, and `simtraffic: 'SIM'` in `shell-car/model.js` CODES,
  in a commit of its own (3bacd04) so it is easy to drop or re-place.
- `core/interaction/targetExtras.js` takes `plugins` ({ rows, actions,
  onSelect } with a `{ refresh }` ctx): other workers can add card extras the
  same way.
