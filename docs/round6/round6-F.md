# Round 6, worker F: own position, GEO, the user's marker

The owner: GEO was slow, sometimes did nothing, imprecise, and there was no
icon for the user on the map. Now every shell shares one position model with a
filter, a ctOS marker the user can choose, a GEO cell that answers at once, and
the Android app feeds it the phone's own GPS.

## What I built

- `core/geo/selfPosition.js` (Cesium-free, tested): the Self position contract
  from the BRIEF, exactly: `createSelfPosition(viewer, { settings })` ->
  `{ get, subscribe, start, stop, locate, push, setIcon, icons }`, plus extras:
  `lastKnown()`, `watch(fn)` (state: status, sensing, following, locating),
  `status()`, `setCompass(deg|null)`, `follow(on)`, `following`, `icon`,
  `destroy()`.
  - Sources, opened only while held (`start(owner)` / `stop(owner)`, owners are
    counted per name, no name = `'default'`) and never while the page is
    hidden: the Android app's native GPS when `window.ArgusAndroid.startLocation`
    exists, otherwise the browser (`watchPosition` high accuracy plus one quick
    low-accuracy `getCurrentPosition` so the first fix is fast; a quiet watch
    is re-read every 20 s and on every `locate()`), plus anything pushed.
  - Filter (`createFixFilter`, exported): an implausible jump (farther than
    both accuracies plus 90 m/s of travel) is rejected unless three fixes in a
    row agree on the new place; an older or duplicate reading never replaces a
    newer one; a worse fix loses to a better recent one until the better one's
    uncertainty has grown past it; a still receiver keeps its anchor while
    fixes fall in the noise band (moves only for a clearly better fix or a real
    move); heading from the course when moving (reported, else the bearing
    between fixes), from a shell-pushed compass when still, else the last
    course.
  - `locate({ timeoutMs })`: a fix younger than 30 s at once (no sensors);
    otherwise opens the sensors and resolves on the first fresh fix; on
    timeout the coarse fix of this session, else the last known one (a
    previous session's, from the cache), else null; null at once when
    refused. A new `locate()` retries after a refusal.
  - `get()` returns a fix at most 5 minutes old (with `t`, so check freshness);
    `lastKnown()` returns the remembered one however old.
  - Cache: `localStorage['argus.selfFix']` (lat/lon to 6 decimals, accuracy,
    t), written at most every 15 s and when sensing stops or the page hides;
    kept a week. Per-viewer convenience only; FORGET THIS DEVICE removes it
    (it starts with `argus.`).
  - Failures: one log entry per kind per session through `log` (main passes
    `app.logs?.add?.(entry)`, source `'GEO'`), plus `console.warn` for warn
    level. No notifier popups anywhere.
- `core/geo/selfMarker.js` (Cesium, loaded on demand): the marker on the globe
  for desktop and mobile. One BillboardCollection (icon + pulse), always on top
  (`disableDepthTestDistance: Infinity`, own limb culling), turned to the
  heading with the SDK's north-aligned axis; dead reckoning along the course
  (at most 2.2 s) eased onto each fix, so 1 Hz GPS reads as smooth motion;
  frames claimed from the shared pacer only while it moves, turns or pulses
  (measured: 0 renders while still). Accuracy ring: ground fill and outline
  through the existing `createGroundBatch` (async build, no flicker), rebuilt
  only for a visible change, hidden at driving speed (it would trail) and when
  zoomed far out. Locating: the ctOS bracket pulse at the last known spot,
  marker greyed while the fix is not live. Follow-me: a stand-in entity as
  `viewer.trackedEntity` (the tracker's FOLLOW pattern), yields when anything
  else takes the camera.
- `core/geo/geoControl.js` (tested): the GEO cell's behaviour, shared by
  mobile and desktop. Tap 1: a fix < 30 s old flies at once (0.8 s); else the
  last known place at once (or the first old fix a sensor hands over),
  LOCATING, then a short hop onto the fresh fix; a coarse first fix is refined
  for 20 s while the view is untouched; it never yanks the view back if the
  user moved it. Tap 2 (view still where GEO left it): follow-me. Tap 3: off.
  Sensors held while in use and 3 minutes after; follow-me holds them while it
  lasts. Altitude from accuracy (1.8 km for a good fix, up to 30 km).
  `flyToSelf()` serves Around Me (regional height, last known at once).
- `core/ui/selfIcons.js` (tested): seven ctOS icons drawn on canvas (CHEVRON
  default, CTOS TRI, DIAMOND, CAR, CROSSHAIR, DOT, BEAM: a fading view beam),
  white with the map glyphs' dark keyline; DOT, DIAMOND and BEAM draw their
  heading mark only when a heading is known. The picker
  (`createSelfIconPicker`) is a row of ctOS tiles with previews.
- GEO cell (`core/ui/zoomControls.js` + `.css`): states on the cell (blinking
  green corners while locating, green corners once centred, solid green while
  following, red on error) and a short note beside it (`±6 M` in the unit
  setting, `LOCATING`, `FOLLOW`, `DENIED`, `NO FIX`, `LAST KNOWN`) that fades.
  The old popups on failure are gone. `createZoomControls({ camera, geo })`
  replaces `onLocate` / `onNotify`.
- Shells: mobile and desktop expose `geo(camera, opts)` (creates the GEO
  control on `app.selfPosition`), `aroundMe` via `flyToSelf`, and `observer`
  (mobile: `locate`; desktop: `get()` only, never a prompt). Both fall back to
  the old `core/geo/geolocate.js` when `selfPosition` is missing. Mobile adds
  `shell-mobile/selfCompass.js`: absolute device orientation pushed into
  `setCompass` at most 10 Hz, only while the sensors are open.
- Car (marker only): `shell-car` draws the chosen icon (same drawing) instead
  of its SVG chevron, turns it only for icons that turn, and exposes
  `setSelfIcon(id)` which main's selfPosition calls (`onIcon`).
- Android (`MainActivity.kt`): `window.ArgusAndroid.startLocation()` /
  `stopLocation()` (JS bridge). While wanted, resumed and permitted, a
  `PhoneLocationFeed` (LocationManager GPS + network at 1 Hz, network skipped
  while GPS flows, the newest last-known fix pushed at once, the same approach
  as the car's CarLocationFeed) pushes
  `window.argusHost.location(lat, lon, heading|null, speed|null,
accuracy|null, epochMs, 'gps'|'network')`; the fix time comes from
  `elapsedRealtimeNanos`, so clock skew cannot age a fresh fix. Status goes to
  `window.argusHost.locationStatus('denied'|'off'|'unavailable')`. Asks for
  the permission on the phone when missing (once per request; a refusal tells
  the page). Off in `onPause`, back in `onResume` if the page still wants it,
  reset when a page loads. The page resets it at start too. With no provider
  ('unavailable') the page falls back to the WebView's geolocation. The
  manifest needed nothing new. The WebView keeps working without the bridge.

## Settings

- `selfIcon`: `'chevron'` (default) | `'triangle'` | `'diamond'` | `'car'` |
  `'crosshair'` | `'dot'` | `'beam'` (store.js, one block after `startView`).
  Picker: SETTINGS > INTERFACE > MY POSITION ICON.

## main.js changes (two blocks)

1. In `main()`, right after `app.settings = settings`: import
   `createSelfPosition` and set `app.selfPosition = createSelfPosition(app.viewer,
{ settings, render: shellName !== 'car', fps: app.profile?.animationFps,
onIcon: app.setSelfIcon, log: (entry) => app.logs?.add?.(entry) })`.
   It exists before `setupScene`, so every later block can use it.
2. View stack: `createZoomControls({ camera, geo: app.geo?.(camera, {
beforeFollow: () => tracker?.unfollow?.(), log, units }) })` replaces the
   `onLocate` / `onNotify` pair.

## For the other workers

- C (navigation): `app.selfPosition.start('nav')` while navigating and
  `stop('nav')` after (owners are separate, so GEO never stops your feed),
  `subscribe(fix => navigator.update(fix))`, and `get()` / `locate()` for the
  origin. Fix `t` is epoch ms; `source` is `browser`, `gps`, `network`,
  `cache` or what a pusher passed.
- D (car): the car page's `selfPosition` draws nothing (`render: false`) and
  opens no sensor unless asked. To share the car's fixes with core (for
  navigation), push them: `app.selfPosition?.push({ lat, lon, heading, speed,
accuracy, source: 'car' })` from `setLocation`. I changed only the marker in
  `shell-car/index.js`: the `drawSelfIcon` block replacing the SVG, the
  `turnsWithHeading` check in the postRender rotation, and `setSelfIcon` in
  the returned object. The car reads the icon from its own settings store at
  boot (both WebViews share the origin's storage); a change made on the phone
  reaches the car on its next load.
- B (logs): entries arrive as `{ level, source: 'GEO', title, body }`, titles
  `LOCATION DENIED`, `LOCATION OFF`, `NO LOCATION SENSOR`, `LOCATION SLOW`
  (info), `LOCATION TIMEOUT` (info), `NO POSITION`.

## Tests

- New: `core/geo/selfPosition.test.js` (20: helpers, filter jumps / consensus
  / worse fix / settling / course heading, locate timing with fake timers,
  refusal, no sensor, owners and visibility, cache and staleness, compass,
  native bridge, icon setting), `core/geo/geoControl.test.js` (12: instant
  path, follow toggle, user moved, LOCATING with last known, stale preview,
  no yank back, error state, hold timing, refinement, units, Around Me),
  `core/ui/selfIcons.test.js` (5: list, schema match, turning, every icon
  draws inside its box with and without its heading mark),
  `shell-mobile/selfCompass.test.js` (2).
- Full suites: core + shells 683 tests, 681 pass; the 2 failures are the known
  missing-package ones (satellites/propagate, scene/occlusion). Proxy: 129/129.
- eslint (scratchpad config) clean, prettier clean on every changed file.

## Harness checks (stub Cesium, port 5207, real browser geolocation via

Playwright `grantPermissions` + `setGeolocation`)

- Desktop: GEO from the whole-Earth view: state centred in about 120 ms, the
  camera at 1.8 km after the 0.8 s flight; marker shown at the fix, accuracy
  ring present (visible close up, hidden under the icon at 1.8 km for a 14 m
  fix, as intended). Second tap: follow-me (cell solid green, note FOLLOW);
  walking north-east at 1 Hz: the chevron turned to 38 degrees, the camera
  rode along, the ring hid at speed and came back once stopped. Third tap:
  off. Away and back with a recent fix: centred state in 50 to 130 ms, camera
  down in about 0.7 s. Picker: tiles render, CAR selected writes the setting
  and the globe marker switches to the car icon. Driving east: rotation
  -90 degrees.
- Slow GPS (every answer 4 s late, a remembered fix 2 h old): GEO flew to the
  remembered place within 1.9 s with the bracket pulse and a grey marker,
  LOCATING on the cell; the fresh fix at 4.1 s: a 0.6 s hop, centred.
- Mobile (?shell=mobile): Around Me at boot puts the marker on the map (with a
  slow GPS it flies to the remembered place at once and does not fly again
  for a 1.4 km correction at 120 km); GEO, follow-me and the picker (two rows
  of tiles) work as on desktop.
- Refused permission: the cell turns red with DENIED for 3 s, one console
  warning, no notification added, then idle.
- Render cost: 0 renders in 3 s while the marker is still; 20 per second
  while moving (the profile's animation rate); back to 0 after stopping.
- Car (?shell=car with selfIcon 'car' stored): the car marker is the CAR icon
  canvas, positioned and turned by setLocation.

## Not verified here

- Nothing ran on real Cesium: the BillboardCollection marker, the ground ring
  (GroundPrimitive / GroundPolylinePrimitive via createGroundBatch), the
  follow stand-in on `trackedEntity` (same pattern as the tracker's FOLLOW),
  and `globe.getHeight` for sitting the marker on terrain are per the Cesium
  API, checked only against the stub.
- The Kotlin compiles only in CI (no Android SDK here): read twice against the
  existing CarLocationFeed and MainActivity code; not run on a phone.
- The phone compass (`deviceorientationabsolute`) and the native GPS timing
  need a real device; the browser path was exercised in headless Chromium.
- Accuracy of the filter thresholds (90 m/s jump bound, noise band 0.8 of the
  accuracy, 3-fix consensus) is reasoned, not tuned on real traces.
