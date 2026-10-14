# Round 8, W1: the car (Android Auto) and the Android app

Owner: "I drove and the arrow didnt follow my tracks"; "I opened it and it
crashed several times"; "the car overview is too big and cant even be closed,
and the car icon looks so bad"; "Doesnt preserve the layers i turned on in the
phone app"; "The layers menu looks like some default android menu"; "the ui
seems like you used default android ui".

## 1. The arrow that stood still

Three causes, all fixed:

- **No fixes on a locked phone.** On the car display Android does not count the
  app as in front (the CarAppService reference says so), so a plain
  `requestLocationUpdates` got the last known fix and nothing more.
  `car/CarLocationService.kt` is a foreground service of type location in the
  same process. The car session **binds** it when the map first shows (with the
  location permission) and unbinds it when the session ends, as the Car App
  Library's navigation sample does: binding is never refused for a background
  start, and the service calls `ServiceCompat.startForeground(...,
FOREGROUND_SERVICE_TYPE_LOCATION)` itself, inside try/catch. If Android
  refuses (no exemption, or the location type refused), it logs and stays a
  plain bound service; the map runs as before. A started service
  (`startForegroundService`) was avoided on purpose: one that cannot then call
  `startForeground` crashes the app. Notification: channel "Car map",
  importance low, silent, "ARGUS : CAR MAP / Using location for the Android
  Auto map", tap opens the app. No `ACCESS_BACKGROUND_LOCATION`.
- **Free look froze the chevron.** The chevron was placed only after a render;
  a resting map in free look renders nothing, so after any drag the arrow
  stopped moving. Now it is reprojected on every fix and five times a second
  while moving (projection only, no map render).
- **No way back to following.** Free look now ends by itself after 10 s
  without a touch while driving faster than 3 m/s (`shouldResumeFollow`),
  never during a route preview; RECENTER still returns at once (and resets the
  zoom, the automatic return keeps it).
- Also: a network fix (no speed) right after driving is no longer held back as
  parked GPS wander (`isParkedJitter`).

## 2. Crashes

- `ArgusApp` (manifest `android:name`) installs a default uncaught exception
  handler that writes time, thread, app version, Android version, device and
  stack to `files/argus/last-crash.txt`, then chains to the previous handler
  (so the system dialog and Android vitals still see it). Next start: a red
  one-line notice on the boot screen (`LAST CRASH : <EXCEPTION> : <time> :
SETTINGS`, tap opens Settings) until it has been looked at; Settings shows
  LAST CRASH with the trace, COPY and CLEAR.
- Hardened with try/catch and logging: `carContext.requestPermissions` (the
  car data permissions are marked asked only after the prompt went out),
  `setSurfaceCallback`, `createVirtualDisplay`, `VirtualDisplay.resize`,
  Presentation creation, `setContentView` and `show` (any RuntimeException,
  not only InvalidDisplayException), both WebView constructions (provider
  missing or updating: the phone shows a boot error with RESTART instead of
  crashing), the renderer-gone rebuild, the session teardown (dismiss after
  the display went), `startForeground`, `bindService`/`unbindService`, the
  port-file read on the health thread (an exception there ended the process).
- `NodeRuntime.tail` read the whole proxy log into memory on the main thread
  (Settings, error screens): it now reads the last 64 KB only.
- Settings was not edge to edge aware: at targetSdk 36 its content ran under
  the status bar; it now pads for the bars, the cutout and the keyboard.
- Not caught: native crashes (libnode, WebView renderer). If it still
  crashes, the owner should send Play Console > Android vitals > Crashes and
  ANRs (stack and device), or with USB: `adb logcat -b crash -d` and
  `adb logcat -s ArgusCar Argus ArgusNode ArgusCrash`.

## 3. The VEHICLE widget

The 360 px panel with the car silhouette is gone. One strip under the status
strip (top left, inside the host's insets): `FUEL [meter] 62% | RNG 256 MI`
(BATT for an electric car; LOW in red when the car says so, the one red in
it). A tap (the car's `argusCar.tap` is hit-tested against it before the map)
opens the rest for 6 s: the car's name, a hybrid's battery, ODO, AVG MPG or
L/100KM, only what the car reports. It hides while moving and during routes as
before, and **VEHICLE INFO** in the car's LAYERS list turns it off
(`Prefs.carVehicleInfo`, pushed as `setVehicleInfo`). Pure part:
`vehicle.js vehicleChip` (tested). The silhouette picker left Settings and
`Prefs.vehicleBody` went with it. The status strip dropped its VIEW cell (the
VIEW button shows it).

## 4. The phone's layers in the car

One source of truth: the phone's session record (`argus.session.v1`, same
origin and localStorage in one process).

- `core/share/session.js`: `sessionLayers`, `withSessionLayers` (changes only
  the car-safe keys, never creates a record: the phone's first launch would
  then resume a view it never had), `layerChanges`, `createSharedLayers`
  (read, write, and follow the other page through the storage event, or on
  `visibilitychange` to visible where the event does not cross WebViews).
- `shell-car/index.js` at mount (before main reads the hash) reads the
  record's layers within `CAR_LAYER_KEYS` and puts them in the share hash, so
  main starts with them; with no record the app's hash (`Prefs.carLayers`, the
  car's last choice, DRIVE on a first run) stays. Toggles (`toggleLayer`) and
  presets (`setLayers`) write the record; a phone change is adopted
  (`adoptLayers`). The page reports `layerState({available, on})` to the app
  whenever either changes (MutationObserver on the off-screen menu).
- `CAR_LAYER_KEYS` (model.js) mirrors `CarLayers.ALL` in MapScreen.kt; a test
  reads the Kotlin list and fails if they drift.
- Kotlin: `CarLayers.setState(available, on)`, the LAYERS list shows the page's
  on-state, a toggle shows at once and is confirmed by the next report;
  `Prefs.carLayers` mirrors the car's on-set (keeping keys this build cannot
  show) and is only the first-run fallback. `pushLayers` is gone: the app no
  longer forces its own set on page load.
- Phone side: one block in main.js (below).

## 5. The car templates

Android Auto draws templates itself (font, row height, toggles, list shape,
button shapes): only icons, words and a few colours are ours. Done:

- ctOS glyphs (white, tinted by the host) on every action and map action and
  on each LAYERS row (`Row.setImage(..., IMAGE_TYPE_ICON)`), drawn from the
  map's own glyphs: cross mark, hazard triangle, report bubble, plan-view
  vehicle, camera brackets, ALPR body and light bar, signal head, the airliner
  and fast-jet silhouettes, radar frame, quake squares. New VIEW glyphs (3D
  tilted ground, 2D grid, N in a frame), DRIVE (the road ahead), VEHICLE INFO
  (a fuel meter); LAYERS, RECENTER and zoom redrawn in the same line weight.
  Contact sheet: `r8-W1/icons.png` in the scratchpad.
- Short caps titles everywhere (WHERE TO, END, LAYERS, 3D/2D/NORTH, NAVIGATE,
  RETRY, AVOID HWY: ON, layer names). VIEW now has its glyph like WHERE TO /
  END / LAYERS.
- LAYERS: no detail text; the presets moved to the list header (the host
  allows two actions there, one titled: DRIVE with its title, SKY as the
  aircraft glyph), which frees rows; VEHICLE INFO is the last row. When the
  host's row limit is short (6 on many hosts), the layers that are on come
  first so they can be switched off, and the list holds still while open.
- Colour: the routing card keeps the ctOS panel colour. Action backgrounds are
  allowed only on a FLAG_PRIMARY action (car API 4+) and are contrast-checked
  by the host; not used.

## 6. Settings and the boot screen

`CtViews.kt`: `CornerFrame` (corner brackets over panel fill and hairline,
theme.css `.ct-frame`), `ctHeading` (white square, tracked caps, hairline),
`ctNote` (one short line), `CtSwitch` (label, a square that fills white, green
ON / grey OFF: no Material switch), `ctButton` (bracketed, no elevation).
Settings: diamond + ARGUS : SETTINGS, `V0.1.0 : PROXY http://...`, LAST CRASH,
KEYS (one line of help), DISPLAY (FULL SCREEN), NETWORK (SHARE ON WI-FI + one
line), VEHICLE (TANK SIZE, US GALLONS, one line), SAVE + RESTART / CANCEL,
PROXY LOG in a framed block. The boot screen keeps its lockup; its error box is
framed, its buttons bracketed, plus the crash notice line. `Ink` gained EDGE
and SUCCESS.

## Files

- New: `android/.../ArgusApp.kt` (app + CrashLog), `CtViews.kt`,
  `car/CarLocationService.kt`, 17 drawables (`ic_layer_*`, `ic_car_view_*`,
  `ic_car_drive`, `ic_car_vehicle`, `ic_stat_argus`).
- Changed: `AndroidManifest.xml`, `MainActivity.kt`, `NodeRuntime.kt` (Prefs:
  `carVehicleInfo`, no `vehicleBody`; tail; health read), `SettingsActivity.kt`,
  `SplashView.kt`, `car/ArgusCarAppService.kt`, `car/CarMapRenderer.kt`,
  `car/CarStats.kt` (no `body`), `car/MapScreen.kt`, `ic_car_layers`,
  `ic_car_recenter`, `ic_car_zoom_in`, `ic_car_zoom_out`, `strings.xml`;
  `shell-car/{index,model,panels,vehicle}.js`, tests, `shell.css`;
  `core/share/session.js` + test; `docs/ANDROID.md`.
- Not touched: `car/SearchScreen.kt`, `car/CarNav.kt` (W2). Their strings
  `car_navigate`, `car_retry`, `car_avoid_on/off` changed value only (caps).

## Manifest and permissions

- `<application android:name=".ArgusApp">`.
- `android.permission.FOREGROUND_SERVICE`,
  `android.permission.FOREGROUND_SERVICE_LOCATION`.
- `<service android:name=".car.CarLocationService" android:exported="false"
android:foregroundServiceType="location" />`.
- No POST_NOTIFICATIONS request: on Android 13+ without it the service still
  runs and shows under the task manager, just not in the shade.

## Shared files

- `main.js`, two places in the session memory block (W4's, round 7):
  1. the block comment above `const sessionMod = ...` (3 lines: the car
     now shows and changes these layers);
  2. inside `if (sessionSaver) { ... }`, after the `window.__argus.session`
     line: one `sessionMod.createSharedLayers({ storage: sessionStore, apply })`
     call (10 lines) that disables / enables what the car changed.
- `core/settings/store.js`, `index.html`: not touched.

## Tests and checks

- `node --test shell-car/*.test.js core/share/*.test.js`: 66 pass (new:
  shouldResumeFollow, network-fix jitter, CAR_LAYER_KEYS == MapScreen.kt,
  vehicleChip, sessionLayers / withSessionLayers / layerChanges /
  createSharedLayers with storage events and visibility).
- `npm test`: 984 pass, 2 fail (satellites/propagate and scene/occlusion:
  satellite.js and cesium missing here, as expected).
- eslint and prettier clean on every changed JS/CSS/MD file.
- Kotlin: type-checked with kotlinc 2.0.21 against android.jar (API 35) and
  the Car App Library 1.4.0 / core 1.13.1 jars (the round 7 `d-kt` setup,
  copied to `r8-W1/ktc`): exit 0, no warnings. Resources and manifest:
  aapt2 compile + link against API 35: ok.
- Real-Cesium harness (proxy 8801, harness 5401), car at 1536x576 and 800x480
  (`r8-W1/car.cjs`): looked at parked, strip open, drive, free look. The strip
  is about 240x30 px; tap opens it, it folds after 6 s; while driving it
  hides. Drive along Highway 111 at 20 m/s, a fix a second: the view follows;
  a pan at 9 s goes to FREE, the chevron keeps moving with the fixes, and the
  view follows again at 19 s. Close-ups (`r8-W1/strip.cjs`, 2x): low fuel,
  EV, hybrid opened, VEHICLE INFO off, hidden on the move.
- Shared layers (`r8-W1/share.cjs`): a phone page and a car page in one
  browser context. Phone flights + satellites + quakes -> car hash
  `layers=flights,quakes`; car toggles flights off and chp on -> record
  `satellites,chp,quakes` and the running phone page follows; the phone turns
  military on -> the car follows.

## Not verified

- No Android build or device here: the Kotlin is type-checked, not run. CI
  must build it.
- Whether Android (16, One UI) lets the bound service go to the foreground
  from the car session, and whether that restores fixes on a locked phone,
  can only be seen in a real car (or the DHU with the phone locked): watch
  for the ARGUS : CAR MAP notification and `adb logcat -s ArgusCar` ("could
  not go to the foreground" means it was refused).
- Play may ask for the foreground service declaration
  (`FOREGROUND_SERVICE_LOCATION`, use: Navigation, shows the driver's
  position on the Android Auto map); docs/ANDROID.md says where.
- The car templates (icons in rows, header presets, the list limit) as
  Android Auto draws them, and the native Settings / boot screen, were not
  seen on a screen.
- Whether storage events cross between the phone and car WebViews in one
  process is untested; the visibility fallback covers the case where they do
  not (the page that missed it catches up when shown again).
