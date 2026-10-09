# Round 6, worker D: Android Auto as a GPS, and the car's VEHICLE panel

Scope: `android/**`, `shell-car/**` (plus the Android Auto part of
`docs/ANDROID.md`). Nothing in `core/` or `main.js` was changed.

**Base:** this branch starts from `2231757` ("Android Auto: lighter and easier
to use in the car", the head of `claude/funny-lovelace-cftlid`), not from
`fece91d` like the other workers: the car performance work this round keeps
(pixel budget, render only on change, jitter hold, viewport refresh) is in
that commit, and it touches the same car files. Merging this branch brings
`2231757` with it.

## What it does

### Android Auto (Kotlin, Car App Library 1.4.0)

- **MapScreen** (NavigationTemplate): action strip WHERE TO (search icon) or,
  on a route, END; then LAYERS and VIEW as before. Map action strip as before,
  now only on car API level 2+ (`setMapActionStrip` is `@RequiresCarApi(2)`).
  On a route: the routing card in ctOS panel grey (`#202020`), `RoutingInfo`
  (current step: Maneuver + ctOS icon, cue = instruction, road, distance;
  next step), loading while rerouting or before the first progress,
  `MessageInfo` ARRIVED on arrival, and the destination `TravelEstimate`
  (remaining distance, time, ETA; remaining time yellow at 5+ min of traffic
  delay).
- **SearchScreen** (SearchTemplate): before typing, the last five
  destinations (Prefs `carRecents`) with their distance from the phone's fix;
  typing searches after a 450 ms pause (2+ characters), submit searches at
  once; rows: name, "distance · detail" (DistanceSpan, host units), ctOS icon.
  Spinner only while the first answer is pending. Keyboard opens by default
  only when there are no recents to tap.
- **RoutePreviewScreen** (RoutePreviewNavigationTemplate): up to three routes
  (`CONTENT_LIMIT_TYPE_ROUTE_LIST` on API 2+), title = duration (DurationSpan),
  text 1 = distance + "via <summary>", text 2 = "+N min traffic" (yellow at 5+)
  · "N lights" · "no highways". Selecting a row highlights that route on the
  map (`argusCar.selectRoute`). Action strip: **Avoid hwy: on/off** (Prefs
  `carAvoidHighways`), which re-plans while the old list stays on screen (a
  refresh, not a new template step); NAVIGATE pressed mid re-plan starts as
  soon as the new routes land. No route / page not ready / no position:
  MessageTemplate with RETRY (and the highway switch when it is on).
  NAVIGATE: `CarNav.start` then `popToRoot` (back to the NavigationTemplate,
  which resets the host's template quota). Template steps: map 1, search 2,
  preview 3 (4 for the error message).
- **CarNav** (session state + bridge): request ids for search and preview,
  timeouts (search 12 s, routes 30 s), stale answers dropped.
  `NavigationManager`: callback set at session start, `navigationStarted()` on
  NAVIGATE, `navigationEnded()` on END / arrival (auto-end 45 s after
  ARRIVED) / page dropping the route; `onStopNavigation` stops everything.
  `updateTrip(Trip)` on every nav update (destination + estimate, current step
  - step estimate, current road; loading while rerouting); every call guarded.
    If the car page reloads mid-route (renderer crash), it re-plans to the same
    destination and navigates the best route (8 tries, 3 s apart, because the
    navigator reaches the page a moment after it mounts).
- **Maneuvers**: the page maps the OSRM vocabulary to `Maneuver.TYPE_*`
  (`shell-car/nav.js carManeuver`, tested); Kotlin checks the type range and
  falls back from ENTER*AND_EXIT roundabouts without an exit number to
  ENTER, never sends angle types. 22 white ctOS vector drawables
  `res/drawable/ic_nav*\*.xml`(corner brackets, square caps, the road not
taken dimmed), generated from`shell-car/maneuvers.js`(the browser banner
draws the same paths): straight, turn/slight/sharp left and right, U-turn
left/right, fork, merge (left, right, unspecified), ramp left/right,
roundabout cw/ccw, depart, arrive, arrive left/right. Plus action icons`ic_car_search`, `ic_car_end`, `ic_car_navigate`, `ic_car_place`,
`ic_car_recent`.
- **CarStats** (`CarStatsFeed`): `app-projected:1.4.0` added; on car API 3+
  `CarHardwareManager.carInfo`: `fetchModel`, `fetchEnergyProfile`, energy
  level (fuel %, battery %, range, low fuel), mileage (odometer), speed
  listeners; values only when `STATUS_SUCCESS`, range-checked; sent to the
  page as one JSON at most once a second (`argusCar.setCarInfo`), re-sent
  after a page reload. Consumption baseline (Prefs `fuelBaselinePct`,
  `fuelBaselineOdoM`): reset at a fill-up (gauge up 2+ points), when the
  odometer goes back, or when none.
- **Permissions**: manifest declares `android.car.permission.CAR_INFO`,
  `com.google.android.gms.permission.CAR_FUEL`, `CAR_MILEAGE`, `CAR_SPEED`
  (the Car App Library docs' Android Auto permissions for CarInfo). The three
  gms ones are requested once (Prefs `carDataAsked`) with location in a single
  `carContext.requestPermissions` at session start (API 3+); a grant restarts
  the feed. CAR_INFO is not a runtime permission on a phone.
- **Settings** (phone): new VEHICLE section: fuel tank size (litres, or US
  gallons with a switch that converts what is typed; Prefs `tankLitres`,
  `tankGallons`) and the silhouette (AUTO / SEDAN / SUV / EV, Prefs
  `vehicleBody`).
- **Layers**: `signals` ("Traffic lights", worker E1's layer) added to
  `CarLayers.ALL` after surveillance, as the coordinator asked.

### Car page (shell-car)

- Bridge, page side, exactly as the BRIEF: `argusCar.search(query, reqId)` ->
  `ArgusCarHost.searchResults(reqId, json)`; `argusCar.preview(placeJson,
optsJson)` -> `ArgusCarHost.routes(json)`; `navigate(routeId)`, `stopNav()`,
  `setCarInfo(json)`; `ArgusCarHost.nav(json)` at most once a second plus at
  once on a new status, route or step (`nav.js createNavGate`, tested; nothing
  sent when nothing the card shows changed). Extra, D-owned:
  `argusCar.selectRoute(id)`. JSON shapes:
  - searchResults: `{ results: [{ id, name, detail, kind, lat, lon,
distanceM, distance: { value, unit } }], error? }`
  - routes: `{ reqId, routes: [{ id, provider, summary, distanceM, distance,
durationS, trafficDelayS, signals, signalDelayS, avoidHighways,
warnings }], error? }` (no geometry; `reqId` comes from optsJson)
  - nav: the contract's `{ status, maneuver, instruction, roadName,
distanceToStepM, then?, distanceRemainingM, durationRemainingS, eta }`
    plus `routeId, stepIndex, stepDistance, remaining, timeToStepS,
currentRoad, trafficDelayS, signalsAhead, offRoute, destination`;
    `maneuver` = `{ type: Maneuver.TYPE_* number, icon, exitNumber?, kind:
the OSRM type, modifier, exit }`.
  - errors: `STARTING` (before mount), `NAVIGATION OFFLINE` (no navigator
    yet), `NO POSITION`, `NO DESTINATION`, `NO ROUTE`, `SEARCH FAILED`.
- **Navigator injection**: the shell never imports `core/nav`. The object it
  returns has `setNavigator(nav)` (anything with search / plan / start / stop /
  update / subscribe); `bootOpts.navigator` also works. Until one is set,
  searches and plans answer NAVIGATION OFFLINE.
- **Map**: preview draws the candidates (alternatives grey, the selected one
  white on a dark keyline) and frames them in the part of the screen the
  host's list leaves free; the route being driven is white ahead and grey
  behind (split at the navigator's snapped point, 1 Hz, one
  PolylineCollection, positions converted once per route), destination as a
  bracketed target with its name (`routeView.js`).
- **Follow view on a route**: looks ahead along the route (the look point is
  on the route, so the view leans into bends), steers by the road below 3 m/s
  (GPS course is noise), zooms to 0.55x, 0.38x within 300 m of a maneuver
  below motorway speed (`nav.js navZoom`, tested). New for every follow view:
  the vehicle is centred in the free part of the screen (routing card, action
  strips), by sliding the look point sideways (`model.js metresPerPixel`,
  tested), instead of the canvas centre; insets changes re-settle the view.
- **Readout**: hidden while previewing; on a route two rows, narrower, and
  only when 900+ CSS px are free (so it never covers the vehicle).
- **Browser only** (no `window.ArgusCarHost`): a ctOS maneuver banner top
  left (glyph, distance, road, THEN glyph, ETA line). In the app nothing of
  it is created.
- **VEHICLE panel** (`panels.js`, `vehicle.js`, tested): ctOS frame, make
  model year, side silhouette (sedan / SUV / EV from the fuels, or the phone
  setting), FUEL % with meter, BATTERY % (EV, hybrids), RANGE, ODO, AVG MPG
  (US or imperial gallons by region) or AVG L/100KM, LOW FUEL tag. Shown when
  parked: speed under 1 m/s for 3 s (the car's speedometer when fresh, else
  GPS); hidden at once above 1.5 m/s; never while previewing or on a route
  (except arrived). Unknowns read `--`; with no car data at all the panel
  stays away. Consumption: fuel drop x tank / distance since the fill-up,
  shown after 8 km and 0.5 L, sanity 1 to 40 L/100 km.

## Files

- `shell-car/index.js` (bridge, nav state, route view, follow look-ahead,
  vehicle panel wiring), `shell-car/model.js` (+ `metresPerPixel`, `ahead`
  option in `followPose`, `signals` code), `shell-car/shell.css`.
- New: `shell-car/nav.js`, `nav.test.js`, `vehicle.js`, `vehicle.test.js`,
  `maneuvers.js`, `routeView.js`, `panels.js`.
- `android/app/build.gradle.kts` (app-projected), `AndroidManifest.xml`
  (car data permissions), `NodeRuntime.kt` (Prefs), `SettingsActivity.kt`,
  `car/ArgusCarAppService.kt`, `car/CarMapRenderer.kt`, `car/MapScreen.kt`;
  new `car/CarNav.kt`, `car/SearchScreen.kt`, `car/CarStats.kt`;
  `res/values/strings.xml`; 27 new drawables.
- `docs/ANDROID.md`: permissions table, Android Auto intro, new Navigation
  and Vehicle sections, readout and browser notes.

## main.js wiring (for the integrator; not done here)

The navigator module (worker C) does not exist in this worktree, so main.js
is untouched. After `proxyClient` is created in `setupScene`:

```js
// Car GPS (shell-car): the car page searches, plans and follows routes with
// the navigator, through the proxy.
if (app.shell === 'car' && proxyClient) {
  const { createNavigator } = await import('./core/nav/navigator.js');
  app.setNavigator?.(createNavigator({ proxyClient }));
}
```

If main already builds one shared navigator (say `app.navigator`), pass that
instead: `app.setNavigator?.(app.navigator)`. The car shell also pushes the
phone's fixes into `app.selfPosition?.push?.(fix)` (worker F) and logs
search/route failures to `app.logs?.add?.()` (worker B) when they exist.

## Settings keys

Android `Prefs` (SharedPreferences "argus"): `carRecents`, `carAvoidHighways`,
`carDataAsked`, `tankLitres`, `tankGallons`, `vehicleBody`,
`fuelBaselinePct`, `fuelBaselineOdoM`. No web settings keys, no feeds.

## Tests and checks run

- `node --test` core + shell-mobile + shell-terminal + shell-car: 670 tests,
  668 pass, the 2 known failures only (propagate, occlusion). Proxy: 129/129.
- New tests: `shell-car/nav.test.js` (maneuver mapping incl. every
  type/modifier/side combination maps to a real TYPE\_\* with a glyph,
  roundabout exits, driving side, display distances, payloads, nav gate
  pacing, route index/locate/walk, nav zoom), `vehicle.test.js` (variant,
  consumption, MPG, panel rows, parked tracker), `model.test.js` (look-ahead,
  metres per pixel).
- eslint (scratchpad config) and prettier: clean on `shell-car/`,
  `docs/ANDROID.md`.
- **Kotlin compiled here**: downloaded `android.jar` (platform 35) and the
  Car App Library 1.4.0 `app` + `app-projected` AARs (plus core, lifecycle,
  annotation, versionedparcelable) from Google Maven, generated stand-in
  `R`/`BuildConfig`, and compiled every `android/app/src/main/java` file with
  Kotlin 2.0.21 (`kotlin-compiler-embeddable` from Gradle's lib): exit 0, no
  warnings. Signatures, nullability, API names checked against the real
  library classes (javap) and sources (validation rules for RoutingInfo,
  Maneuver, RoutePreview item lists, action strip limits).
- **aapt2** (8.7.3 from Google Maven): resources + manifest compile and link
  against android.jar 35.
- Harness (`?shell=car`, 1536x576, dpr 1.25, fake navigator with canned
  routes, and a recording `window.ArgusCarHost` for the in-app run): parked +
  setCarInfo shows VEHICLE; search answers `searchResults`; preview draws
  three routes framed right of a 430 px host list, VEHICLE hidden; select
  switches the white route; AVOID HWY re-plan passes `avoidHighways: true`;
  navigate follows with travelled grey / ahead white, readout two rows, the
  vehicle centred in the free area; 11 nav messages in 34 s, minimum gap
  1005 ms; arrival sends `arrived` with `DESTINATION_RIGHT`; stopNav clears
  the route and VEHICLE returns when parked. Browser run: maneuver banner
  with glyph, distance, road, THEN glyph and ETA line. Perf drive (no nav):
  driving 23.6 fps, parked 10.8, GPS wander 12.4, motorway 22.0, in line with
  the previous round.

## Not verified (no SDK, no car, no navigator here)

- Nothing ran on a phone, the DHU or a car. The Kotlin compiles against the
  real library, but host behaviour is untested: template refresh vs step
  counting on AVOID HWY, search-as-you-type limits, routing card colours,
  cluster `updateTrip`, `onStopNavigation`.
- Car data permissions are from the Car App Library documentation as I know
  it (CAR_INFO for the model; gms CAR_FUEL / CAR_MILEAGE / CAR_SPEED for
  energy, odometer, speed); not checked on a device. If Android Auto wants
  CAR_FUEL for the energy profile too, it is already requested.
- The vector drawables' path data is plain SVG syntax (aapt2 accepts it; the
  browser renders the same paths); Android's PathParser only runs on device.
- The real navigator (worker C) was not available: the page was driven by a
  fake with the contract's shapes. Reroute, off-route and arrival semantics
  are whatever C's navigator emits; the page handles `rerouting` (new route
  drawn in place) and `arrived`.
- The harness stub is not Cesium (it ignores heading and pitch), so the
  look-ahead, zoom and route framing were checked by numbers and tests, not
  by eye on a real globe.

## For other workers

- C: the car consumes `createNavigator` exactly per the contract: `search(q,
{ near, limit: 8 })`, `plan(from, to, { mode: 'drive', avoidHighways,
traffic: true })`, `start(route)`, `stop()`, `update(fix)` with `t` in
  epoch ms, `subscribe`. It reads `progress.snapped` (to split the route),
  `progress.step` / `then` / `stepIndex` / `distanceToStepM`, and
  `route.steps[stepIndex - 1].name` as the current road. A step's optional
  `drivingSide` ('left' | 'right', as OSRM has it) is honoured for U-turns,
  ramps and roundabouts; otherwise the phone's region decides.
- E1: `signals` is in the car's LAYERS list; the car's readout code for it is
  `SIG`.
