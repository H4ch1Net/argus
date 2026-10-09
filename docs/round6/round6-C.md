# Round 6, worker C: navigation (core/nav, WHERE TO, turn by turn)

What the owner asked for: a destination you set from a search bar or by
pressing the map, routes that take traffic lights and traffic into account,
an avoid-highways option, drive / walk / bike on the FOSSGIS servers, more
TomTom, all in the ctOS style and on every version (PC, Linux, Android,
Android Auto).

## What I built

### core/nav (pure, shared: browser, terminal, car)

| File                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigator.js`             | `createNavigator({ proxyClient, now, hasFeed?, signals?, signalTimeoutMs?, log? })`, exactly the Navigation contract in the brief: `search`, `plan`, `start`, `stop`, `update`, `state`, `subscribe`. Extras (beyond the contract, harmless): `select(route)` (highlight an alternative while previewing), `traffic` (TomTom routing available), `reverse(lat, lon)` (a dropped pin's name via Nominatim), `lastFix`. State adds `error` (a short ctOS reason when a plan fails); progress adds `alongM`; routes add `signalsAlongM` and, for TomTom, `traffic` sections. |
| `providers.js`             | Three routers as request/parse pairs into the Route shape: OSRM (FOSSGIS, alternatives on), Valhalla (FOSSGIS; avoid highways with `use_highways: 0`; heading on reroute), TomTom Routing (`traffic`, `computeTravelTimeFor=all`, `avoid=motorways`, `maxAlternatives=2`, `sectionType=traffic`, `vehicleHeading`). `providerChain`: driving with traffic on and the TomTom key: TomTom, then OSRM / Valhalla; avoid highways: Valhalla then OSRM (marked `HIGHWAYS NOT AVOIDED`); else OSRM then Valhalla. Each falls back to the next.                                  |
| `maneuvers.js`             | Valhalla types and TomTom codes mapped into OSRM's vocabulary (roundabout exits folded into the entry, with the exit number and the turn from the bearings); `maneuverLabel` / `instructionText` (short ctOS upper case: `TURN RIGHT ONTO FOLSOM STREET`, `ROUNDABOUT EXIT 3`, `KEEP LEFT`).                                                                                                                                                                                                                                                                              |
| `progress.js`              | The progress engine: snap to the route (windowed 200 m back / 3 km ahead so a route that doubles back does not jump, whole line when the window misses), along-route distance, current and next step, distance to the step, distance and time left (step times pro rata plus the expected wait at each signal ahead), ETA; off route after 3 fixes over 40 m (fixes worse than 100 m accuracy ignored); arrival within 25 m.                                                                                                                                              |
| `signals.js`               | OSM `highway=traffic_signals` within 15 m of the route: the corridor cut into 0.02 degree tiles, missing tiles fetched 12 per Overpass query (`out skel`), cached 6 h (reroutes, alternatives, the way back cost nothing); nodes within 40 m along the route merge into one junction. Gives `signals`, `signalDelayS`, `signalsAlongM`. A trip over 48 tiles counts its first and last 24 (and says so).                                                                                                                                                                  |
| `search.js`                | Places from the bundled list, Photon and TomTom Search (when keyed) in parallel, biased near the user or the view centre, merged and deduplicated; one source failing never hides the others. `reverseName` for dropped pins.                                                                                                                                                                                                                                                                                                                                             |
| `format.js`                | Driver-rounded distances (`350 M`, `1.2 KM`, `0.3 MI`, `400 FT`), durations, delays, local clock, per-route facts.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `simulate.js`              | A simulated drive along a route at each step's own pace (the SIM button, tests, the harness).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fixSource.js`             | Where the user is: `app.selfPosition` (worker F) when present, else `navigator.geolocation`; `get`, `locate`, `watch`. Browser APIs only, no Cesium.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mockProxy.js`             | Dev only, no proxy: synthetic answers in the routers' real formats (an L-shaped route on a street grid, signals on the grid, demo places), so the real parsers run; the panel shows `DEMO`.                                                                                                                                                                                                                                                                                                                                                                               |
| `routeLines.js`, `view.js` | Cesium (browser only, never imported by the terminal): route lines, destination marker, puck, follow camera (below).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**Signal delay assumption** (documented in `signals.js`): a 90 s cycle, about
half red; a random arrival waits on average half the red phase, half the time,
plus a few seconds to stop and pull away: about **12 s per signal driving**,
10 s cycling, 8 s on foot. Routers' times already include a little (OSRM's car
profile adds 2 s per signal), so it leans long by about that. TomTom's
traffic-aware times come from measured speeds, so a TomTom route with traffic
gets **no added signal delay** (the count still shows). Routes are ranked by
`durationS + signalDelayS`.

### UI (core/ui/navPanel.js, navPanel.css, navGlyphs.js), desktop and phone

- **WHERE TO** prompt: desktop top centre under the bar (`G` focuses it),
  phone under the bar clear of the stack. Results are launcher rows with the
  distance from you; empty focus offers PICK ON THE MAP and the selected
  TARGET. Focusing it starts locating you.
- **Setting the destination**: a result; a long press (touch, pen; 550 ms) or a
  right click on the map opens a small menu (ROUTE HERE / ROUTE FROM HERE) at
  the press; **ROUTE HERE** on any target card (anything below 100 km
  altitude); TOOLS > ROUTE. A dropped pin is named by Nominatim reverse.
  The ctOS destination marker: corner brackets round a diamond with a green
  (locked) core on a stem, clamped to the ground.
- **Preview card** (desktop under WHERE TO; phone just above the sheet, the
  sheet collapses): FROM (MY LOCATION / MAP / TGT), DRIVE / WALK / BIKE,
  AVOID HIGHWAYS (driving), TRAFFIC (only when the proxy has the TomTom key),
  up to 3 routes A/B/C with time, distance, traffic delay in red, ETA and
  SIG count, tap to choose; warnings (`HIGHWAYS NOT AVOIDED`, `TRAFFIC +N
MIN`, `CLOSURE ON ROUTE`); GO (from your location only), SIM (simulated
  drive at 3x), FLY (fly along); the credit (OSRM / Valhalla / TomTom, OSM,
  FIX THE MAP). The camera frames the routes in the part of the screen the
  panels leave free. Choices persist (settings below).
- **Driving**: the turn banner (canvas maneuver glyph, distance to the step,
  maneuver, road, THEN row when the next maneuver follows within 400 m; red
  REROUTING with its own glyph when off route; ARRIVED) and the strip (ETA,
  distance and time left, signals ahead, traffic delay, SIM tag, RECENTER,
  END). GO watches your position (self position, else geolocation) into
  `nav.update`.
- **On the globe**: every route of a plan cut into ~100 m pieces in ONE
  GroundPolylinePrimitive (draped on terrain), **built only when the set of
  routes changes** (a plan, a reroute). Progress, choosing an alternative and
  starting the drive only rewrite per-piece colour attributes (into a scratch
  array): white ahead, grey behind, TomTom jams red, alternatives dim, routes
  not taken transparent. Falls back to plain polylines where ground lines are
  unsupported.
- **Follow camera**: heading up, pitched -38 degrees, looking at a point ahead
  so the vehicle sits low; range 320 m to 1.5 km with speed; dead reckoning
  between fixes (at most 2 s) eased, heading eased; a short fly-in when it
  starts. Runs in preRender with the frame pacer claim (`app.profile
.animationFps`), scratch objects only. A drag (over 10 px) or a wheel hands
  the camera back (RECENTER shows). Off in the car shell (`follow: false`).
- **Puck** (chevron) only when there is no `app.selfPosition` or during SIM,
  so it never doubles worker F's self marker.
- **TOOLS > ROUTE**: the old A/B tool folded in: FROM (ME / MAP / TGT), TO
  (FIND / MAP / TGT), mode, avoid highways, ROUTE / FLY ALONG / CLEAR, all
  bound to the same trip as the preview. `createRouteTool` is gone from
  `core/ui/toolsMenu.js`. DATA CREDITS now lists a Directions group.

### Terminal

`argus route A B [--mode car|foot|bike] [--avoid-highways] [--no-traffic]`
plans through `core/nav` (no Cesium): the same router chain, signals counted,
alternatives listed, the right credit printed; `--json` adds provider,
signals, traffic delay, warnings, alternatives and contract-shaped steps (each
with an English `text`). Usage line updated in `bin/argus.js`.

## main.js wiring (exact changes)

1. Before `interceptTap`: `const navHooks = { swallowTap, cardAction }`, and
   `interceptTap` starts with `if (navHooks.swallowTap()) return true;` (the
   tap that ends a long press or right click is not a pick; it would drop the
   target).
2. `attachTracking(...)` gets `moreActions: (t, rec) => navHooks.cardAction(t, rec)`;
   inside, the parameter is destructured and `moreActions?.(target, rec)` is
   appended to `extraActions`.
3. The old `tools.createRouteTool(...)` block is replaced by one navigation
   block: creates `app.nav` (every shell; demo proxy in dev with no proxy;
   `hasFeed` from `/health`; failures logged to `console.warn` and
   `app.logs?.add`), `app.navView` (every shell; follow off in the car), and on
   desktop and phone the panel (`app.mount('navTop' | 'navBottom')`, the map
   menu appended to `document.body`), sets the two hooks, and exposes
   `nav`, `navView`, `navUi` on `window.__argus` in dev. TOOLS gets
   `navUi?.menuSection()` in place of the route tool.

## Shells

- `shell-desktop`: `navTop` (top centre column) and `navBottom` (bottom centre)
  containers and mount slots; CSS; notices start 46 px lower (below WHERE TO).
- `shell-mobile`: same slots (under the bar; above the sheet's peek);
  `app.collapseSheet()`; notices and floats start below WHERE TO.
- `shell-car`: untouched. Unknown slots are ignored there.

## Settings keys (core/settings/store.js, one block)

`navMode` (drive | walk | bike), `navAvoidHighways` (bool), `navTraffic` (bool, default true).

## Shared registries touched (one contiguous block each)

- `core/credits.js`: credits `valhalla` and `tomtom-nav` after `osrm`;
  `GROUP_LABELS.directions`.
- `core/ui/keymap.js`: `G` Where to.
- `proxy/feeds/nav.js` (my file): three feeds appended (no change to
  `proxy/feeds.js`, nav.js is already spread in).

## New proxy feeds (proxy/feeds/nav.js)

| id               | upstream                                                         | pinned                                                                                                                                                                                                                                                   | budget / cache                              | key                           |
| ---------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------- |
| `valhalla`       | valhalla1.openstreetmap.de `/route?json=`                        | path `/route`; the JSON body checked field by field (2 stops on the globe within the 600 km leg limit, optional heading on the first, costing auto / pedestrian / bicycle, `use_highways` for auto only, km + en-US, at most 2 alternates, nothing else) | 30/min, cache 10 min                        | none (FOSSGIS policy, UA set) |
| `tomtom-routing` | api.tomtom.com/routing/1 `calculateRoute/{lat,lon:lat,lon}/json` | 2 stops within the leg limit; every query key pinned (travelMode, traffic, computeTravelTimeFor=all, maxAlternatives 0..2, instructionsType=text, language=en-GB, routeType=fastest, sectionType=traffic; optional avoid=motorways, vehicleHeading)      | 10/min, **200/day**, cache 2 min (stale 10) | `TOMTOM_API_KEY` as `?key=`   |
| `tomtom-search`  | api.tomtom.com/search/2 `search/{query}.json`                    | one path segment; limit 1..10, typeahead, en-GB, optional lat+lon bias                                                                                                                                                                                   | 20/min, **250/day**, cache 1 h (stale 24 h) | `TOMTOM_API_KEY` as `?key=`   |

`osrm`: `alternatives=true` now allowed (OSRM finds them in the same search).
TomTom budgets: incidents may use 2,000 a day, so 2,000 + 200 + 250 = 2,450,
under the free tier's ~2,500 non-tile requests a day.

## Tests

- New: `core/nav/{geo,maneuvers,providers,signals,progress,search,navigator,format,fixSource,mockProxy}.test.js`;
  `proxy/test/navFeeds.test.js` (+5: Valhalla pins, OSRM alternatives,
  TomTom routing pins and daily budget, TomTom search pins, key injection
  through the relay); `shell-terminal/cli.test.js` (+1: `--avoid-highways`
  through Valhalla, signals, alternatives, JSON).
- Real samples saved as fixtures (`core/nav/fixtures/`, trimmed of verbose
  fields): OSRM car route in San Francisco, Valhalla avoid-highways answer
  with 2 alternates (SF), Valhalla Milton Keynes route with 9 roundabouts,
  Valhalla SF freeway route (fork, exit), Photon "ferry building", Overpass
  traffic signals around the SF route (85 nodes, overpass.kumi.systems: the
  mail.ru mirror answered 504 all session). TomTom fixtures are built to the
  documented shape from the OSRM geometry, marked `-documented`.
- Results after merging 2231757: core + mobile + terminal + car **696 pass,
  2 fail** (the two known ones: satellites/propagate, scene/occlusion);
  proxy **134 pass, 0 fail**. ESLint (scratchpad config) and Prettier clean
  on every file I touched.

## Harness checks (stub Cesium, port 5203; screenshots looked at)

- Desktop, demo proxy: WHERE TO focus and results with distances; result to
  preview with 2 routes, ETA, SIG; choose B; GO; 25 fixes: banner `1.7 KM /
TURN RIGHT / DEMO STREET 22`, strip `ETA 06:57 6.3 KM 12 MIN SIG 11 END`,
  following; three fixes 120 m off: `rerouting` (red banner, reroute glyph),
  then a new route `r3` and `navigating`; drive to the end: `ARRIVED` with the
  destination glyph; END: idle, panels cleared.
- Phone: long press (CDP touch, 700 ms) opens the map menu and keeps the
  selection; ROUTE HERE: preview card above the sheet, route framed above it;
  GO, banner and strip; a drag stops following and shows RECENTER, RECENTER
  resumes; search `paris` with distances.
- Real-proxy path (fake `/health`, real fixtures served for `/feed/*`): Photon
  results; OSRM route with 9 signals; AVOID HIGHWAYS goes to Valhalla with
  `use_highways: 0` (3 routes, 11/12/13 signals); Milton Keynes roundabouts
  simulated: banner `450 M / ROUNDABOUT EXIT 3 / H5 PORTWAY / A509`. With
  TomTom configured: TRAFFIC switch shown, TomTom first, `+1 MIN TRAFFIC`,
  the jam piece of the line red, `ROUTES © TOMTOM`.
- Car shell (`?shell=car`): `app.nav` and `app.navView` exist, plan / start /
  update work, no panels, the follow camera stays off.
- All maneuver glyphs drawn on one sheet and checked (turns, sharp, U-turn,
  fork, merge, ramps, roundabouts with exits, arrive, reroute, marker, puck).

## Not live-tested here

- **TomTom Routing and Search**: no key in this environment (401). Per the
  provider's documentation; parsers tested against documented-shape fixtures.
- **Overpass for signals**: the proxy's default `overpass` feed points at
  overpass-api.de, which is not reachable from here; I took the sample from
  overpass.kumi.systems. Operators can point `OVERPASS_URL` at a working
  instance. When Overpass fails, routes simply carry no signal count (no
  popup; logged).
- The proxy itself could not reach any upstream from this container (Node's
  fetch bypasses the egress proxy); upstream behaviour was checked with curl
  and saved as fixtures.
- Real Cesium: the stub ignores camera pitch and heading, so the follow
  camera's tilt and the ground-polyline recolouring
  (`getGeometryInstanceAttributes`) were not seen on a real globe; the code
  falls back to direct instance attributes when that API is missing (the
  stub), and to plain polylines when ground lines are unsupported.
- A real phone GPS and Android WebView geolocation (only the harness's fixed
  fix and simulated drives).

## For other workers

- **D (car)**: use `app.nav` (one navigator for the whole app; its routes are
  already drawn by `app.navView`, which does not move the camera in the car).
  `createNavigator({ proxyClient })` also works standalone; without `hasFeed`
  it tries TomTom once and drops it for the session if the proxy has no key.
  Route ids are `r1`, `r2`, ... (for `navigate(routeId)`, look them up in
  `nav.state.routes`). `nav.select(route)` highlights an alternative while
  previewing. Instructions are short upper case; `maneuverLabel(step.maneuver)`
  gives the action alone; `core/nav/format.js` has driver-rounded distances.
  Fixes from `window.argusCar.setLocation` should go to `app.nav.update(fix)`
  while navigating (and to `app.selfPosition.push` for F).
- **F (self position)**: navigation reads `app.selfPosition.get/locate/subscribe/start`
  defensively; it never calls `stop()`. When `app.selfPosition` exists the nav
  puck is hidden (your marker shows the user), except during SIM.
- **E1 (traffic lights layer)**: signals here are counted independently
  (own tile cache, `out skel`); both go through the `overpass` feed's
  20/min governor.
- **B (logs)**: navigation failures go to `app.logs?.add({ level: 'warn',
source: 'nav', title, body })` and `console.warn`; no popups for feed
  failures. The only nav notices are user prompts (NO TARGET, TAP THE MAP).
- **Docs**: README / SETUP lines for search, routes and `argus route` updated;
  `docs/AUDIT.md` and `docs/COMPARISON.md` not touched (the integrator's).
  SETUP's TomTom row still speaks of traffic flow only: the same key now also
  gives navigation live traffic and TomTom search.
