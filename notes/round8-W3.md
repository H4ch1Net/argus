# Round 8, W3: tidy menus and GPS that follows

Two owner complaints: the menus were cluttered and messy, and while driving
"the arrow didnt follow my tracks, it just stood in place". Plus the
coordinator's note: the ARGUS lockup looked broken.

Screenshots (real CesiumJS 1.140, real proxy, live feeds) are in
`<scratchpad>/r8-W3/`: `before/` and `after/` hold the same file names, so each
pair compares directly (`before/phone-view-1.png` against
`after/phone-view-1.png`). `after/` also has `phone-open-*` and `desk-open-*`,
with every folded section open and two layers' options open. The drive check
is in `drive/`. Scripts: `menus.cjs` (all menus, `UNFOLD=1` opens the folds),
`splash.cjs`, `drive.cjs` (phone), `deskfollow.cjs` (desktop),
`session.cjs` (session memory and position at launch).

## 1. GPS: why the arrow stood still, and what changed

**Cause.** The position sensors were only open while something held them:
GEO held them for three minutes after a tap, Around Me only for one locate.
After that the native GPS feed was stopped (`ArgusAndroid.stopLocation`) and
the chevron froze at the last fix. Following needed a second tap on an
untouched view, and followed through a Cesium `trackedEntity` stand-in, which
fought the app's own gestures.

**Now** (`core/geo/selfPosition.js`, `selfMarker.js`, `geoControl.js`, new
`follow.js`, `core/ui/zoomControls.*`):

- Position live from launch when location is already allowed, never a prompt:
  `startIfAllowed()` uses the Android app's `hasLocationPermission()` if the
  bridge has it (it does not yet, see below), else whether this device has
  given a real fix before (`argus.geo.ok`, cleared on a refusal); in a browser
  the Permissions API. With `stayLive`, the first real fix keeps the sensors
  open for the session. Hidden page: closed, as before.
- GEO: tap 1 centres and follows, tap 2 heading-up (the cell reads HDG, the map
  tilts to -50 and turns with travel, the chevron low on the screen), tap 3
  frees the map. The follow camera runs per frame after the gestures and
  keeps the user's distance, tilt and turn: a pinch changes the follow
  distance, a twist turns the map (heading-up then drops to plain follow), a
  wheel zooms. A one-finger or left-button drag pauses it and shows RECENTER
  beside GEO; a tap on either recentres with a short glide. A flight the app
  starts elsewhere (search, a place) pauses it; one that ends over the chevron
  (N, TLT) does not. Paused, at 3 m/s or more with the map untouched for 10 s,
  it resumes on its own. FOLLOW on a contact or the cockpit ends it.
- Navigation: the route camera (`core/nav/view.js`, W2) still drives while it
  follows; self-follow waits meanwhile (`setFollowGuard`). GEO during a drive
  calls `navView.recenter()`.
- Nothing holds the chevron still while moving: a new test drives 30 fixes at
  1.6, 14 and 33 m/s (reported speed) and 14 m/s (derived) and checks every fix
  moves the shown position.

**Harness (phone, real Cesium):** after GEO the camera follows within a few
pixels of the chevron while 20 m/s fixes come in (`drive/1-follow.png`);
heading-up turns to 104-112 degrees for a 112 degree road, pitch -51, chevron
low (`2-heading.png`); a touch drag pauses with RECENTER shown
(`3-paused.png`); after 12 s more driving it resumed by itself
(`4-resumed.png`); a pinch took the height from 1186 m to 546 m and follow
stayed on (`5-pinched.png`); the third tap freed it. Desktop: wheel zoom kept
following, a mouse drag paused, RECENTER resumed. With the geolocation
permission granted, the page shows a live position at launch without a tap.

## 2. Menu audit: the clutter list and what changed

From the before screenshots (`before/`):

| #   | Where                            | Clutter                                                                                                                                                                                     | Change                                                                                                                                                                     |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Bar (all)                        | Lockup: diamond + small "AR" in a gray box, then a large "GUS"                                                                                                                              | One wordmark: diamond on a square ctosGray tile, ARGUS in one size; same on desktop and the splash                                                                         |
| 2   | LAYERS                           | 38 rows saying OFF                                                                                                                                                                          | Off rows say nothing; a count only when on (LOAD / ERR / STALE / N/A kept)                                                                                                 |
| 3   | LAYERS                           | Presets in two ragged rows of uneven widths                                                                                                                                                 | Even 3x2 grid                                                                                                                                                              |
| 4   | LAYERS                           | DATA LAYERS 04/42, ALL OFF far down at the end                                                                                                                                              | LAYERS header with `04 ON` and a small ALL OFF beside it (only when something is on)                                                                                       |
| 5   | VIEW                             | Webcam categories (16 bright chips), traffic cam kinds, surveillance scope, Starlink dense, Shodan, weather history: a wall, shown even with their layer off                                | Each is its layer's options: a square beside the row opens them under it, only while the layer is on                                                                       |
| 6   | VIEW                             | A lone SKY button at the top with no label                                                                                                                                                  | POINT AT SKY switch row in VIEW > SCREEN                                                                                                                                   |
| 7   | VIEW                             | 14 sections in no order (BASEMAP, LABELS, TRACKING, CONTACTS, 3D MODELS, EARTH, SATELLITES, WEBCAMS, TRAFFIC CAMS, SURVEILLANCE, CAMERA PREVIEWS, WEATHER HISTORY, SENSOR, DISPLAY, SYSTEM) | MAP, TERRAIN, LOOK, ON THE MAP, SCREEN, then one folded MORE (MAP, EARTH, CAMERAS, LOOK, ROAD SPEED)                                                                       |
| 8   | VIEW > EARTH and SETTINGS > PERF | Globe detail in both                                                                                                                                                                        | Only SETTINGS > QUALITY                                                                                                                                                    |
| 9   | VIEW > SYSTEM                    | Capability readout (RESOLUTIONSCALE, TARGETFRAMERATE, RENDERMODE...)                                                                                                                        | SETUP > MORE > DETAILS                                                                                                                                                     |
| 10  | VIEW                             | Notes under MERGE NEARBY, 3D MODELS, SURVEILLANCE, CAMERA PREVIEWS, WEATHER HISTORY, ROAD FLOW, SHODAN                                                                                      | Removed; the detail is in each control's tooltip                                                                                                                           |
| 11  | VIEW                             | RELOAD OSM (duplicates each OSM layer's own RELOAD square)                                                                                                                                  | Removed; the row RELOAD does the same per layer                                                                                                                            |
| 12  | VIEW                             | TERRAIN heading then a TERRAIN caption                                                                                                                                                      | One heading                                                                                                                                                                |
| 13  | VIEW                             | Basemap S2 / BLUE / NIGHT cryptic, uneven                                                                                                                                                   | 4x2 grid: DARK SATELLITE STREETS TOPO / RELIEF SENTINEL MARBLE NIGHT (full names in tooltips)                                                                              |
| 14  | VIEW                             | TRACKING boxes OFF/LOW/MED/HIGH with no caption                                                                                                                                             | Caption TRACKING BOXES, in SCREEN                                                                                                                                          |
| 15  | TOOLS                            | 14 always-open sections, 8 of them with a paragraph (imagery, share, scenes, watch, tour, landmarks, radio, console)                                                                        | Every tool folds to one line (ROUTE open), everyday ones first (ROUTE, MY PLACES, LANDMARKS, DRAW + MEASURE, SHARE, TIMELINE), the rest under one MORE; paragraphs removed |
| 16  | TOOLS                            | DATA CREDITS, a 3-screen wall, in a tools tab                                                                                                                                               | SETUP > DATA CREDITS, folded                                                                                                                                               |
| 17  | TOOLS > RADIO                    | "Turn on the Radio layer to tune its stations."                                                                                                                                             | A TURN ON RADIO STATIONS button                                                                                                                                            |
| 18  | TOOLS > CONSOLE                  | Note about the backtick                                                                                                                                                                     | Section TERMINAL, one button (backtick in its tooltip)                                                                                                                     |
| 19  | SETUP > KEYS                     | 30 keys, each a name, a FOR line of feed ids and an input with SAVE: 5 screens                                                                                                              | KEYS folded with `n/30 SET`; one line per key, tap to open its field (FOR line inside); EXPORT / IMPORT at the end                                                         |
| 20  | SETUP                            | KEYS note naming /root/.config/argus/.env (mode 600)                                                                                                                                        | "All optional. Saved on this device, never in the page." (path in the tooltip)                                                                                             |
| 21  | SETUP > PERMISSIONS              | Two full-width ALLOW buttons with states above                                                                                                                                              | In STATUS: LOCATION / COMPASS rows with a small ALLOW only when needed; COMPASS only on touch devices                                                                      |
| 22  | SETUP > STATUS                   | PROXY, QUALITY TIER, GPU string, FONT, SECURE CONTEXT                                                                                                                                       | STATUS: CONNECTION, FEEDS, LOCATION, COMPASS, GPU; the rest under MORE > DETAILS                                                                                           |
| 23  | SETUP > PROXY                    | Paragraph about npm run start:https                                                                                                                                                         | MORE > PROXY, one row and the field; hidden in the Android app (its proxy is built in)                                                                                     |
| 24  | SETUP > INSTALL                  | Disabled INSTALL APP, two paragraphs, shown even inside the Android app                                                                                                                     | Hidden in the app and when installed; INSTALL APP only when the browser offers it                                                                                          |
| 25  | SETUP > START                    | Help paragraph and a KEYBOARD button on a phone                                                                                                                                             | Removed; SHORTCUTS under MORE only where there is a keyboard                                                                                                               |
| 26  | SETUP > LOGS                     | Note under the list                                                                                                                                                                         | Removed (tooltip on the header)                                                                                                                                            |
| 27  | SETUP                            | No way to the Android app's own settings                                                                                                                                                    | APP SETTINGS beside SETTINGS in the app; RESTART ARGUS after a key that needs it                                                                                           |
| 28  | Bar                              | -LIVE- opened VIEW                                                                                                                                                                          | Opens SETUP (connection and feeds); on the phone the sheet opens too                                                                                                       |
| 29  | SETTINGS                         | Five tabs, INTERFACE clipped on the phone                                                                                                                                                   | GENERAL / QUALITY / ICONS / DATA (ABOUT at the bottom of DATA)                                                                                                             |
| 30  | SETTINGS                         | Notes: detected tier, resolution, my icon, data                                                                                                                                             | Removed; tier in the caption QUALITY (AUTO: BALANCED), details in tooltips                                                                                                 |
| 31  | SETTINGS                         | Switch rows indented 10 px from the captions                                                                                                                                                | Aligned                                                                                                                                                                    |
| 32  | SETTINGS > ICONS                 | Long note, PER-LAYER switch squeezed beside RESET ICONS                                                                                                                                     | No note; PER LAYER folds like the menus; RESET ICONS at the bottom                                                                                                         |
| 33  | All menus                        | The bar's `.ct-seg` rule (padding 0 3px, centring) leaked into every menu button row, so choices sat 3 px inside the headings                                                               | Scoped to `span.ct-seg` (bar.css); menu rows line up                                                                                                                       |
| 34  | All menus                        | Uneven segmented choices                                                                                                                                                                    | Even grids (`createChoice({ columns })`); `h()` now sets CSS custom properties                                                                                             |

Not changed (others own them or they are data): the ROUTE note in TOOLS and
WHERE TO / long-press (W2), the TARGET tab hint, the search launcher, layer
names (see below), the splash boot log (ctOS flavour).

## 3. Files

- New: `core/geo/follow.js`, `core/geo/follow.test.js`.
- GPS: `core/geo/selfPosition.js` (+ tests), `selfMarker.js`, `geoControl.js`
  (+ tests), `core/ui/zoomControls.js/.css`.
- Menus: `core/ui/controls.js` (collapsible, disclosure, columns),
  `layerMenu.js/.css`, `setupTab.js`, `settingsPanel.js`, `iconSettings.js`,
  `logs.js`, `settings.css`, `theme.css`, `toolsMenu.js`, `dom.js`,
  `hud/bar.js/.css`; notes trimmed in `scenesTool.js`, `watchTool.js`,
  `tourTool.js`, `poiTool.js` (scans when its body opens), `radioTuner.js`,
  `weatherStrip.js`, `roadFlow.js`, `core/layers/shodan/controls.js`;
  `shell-mobile/index.js` (compass row slot, showTab opens the sheet),
  `compass.js/.css`, `shell.css`; `shell-desktop/index.js`, `shell.css`.

## 4. Shared files: exact blocks

`main.js` (hunks against 5cbaea5, by current line):

- ~98-110: selfPosition creation (`stayLive`, `startIfAllowed('app')`).
- ~259, ~291, ~331: one-line comments (menu paths).
- ~1415: the controls import (`disclosure`, `collapsible`).
- ~1700-1708: the -LIVE- segment opens SETUP.
- ~1734-2459: the VIEW block (from `// view menu` to the VIEW assembly after
  the shortcuts), including the terrain choice, `layerOptions(...)` calls,
  and `readout` / `keyboard` passed to `createSetupTab`.
- ~2897-2910: TOOLS > TERMINAL section (was CONSOLE).
- ~2983-3032: TOOLS assembly by section title (replaces `for (const el of
intel) app.mount`), credits mounted in SETUP.
- ~3035-3070: the GEO / zoom controls block (`setFollowGuard`,
  `app.followingSelf`, `intercept`).
- ~3166: `mountRow` passed to `app.enableCompass`.
  The `intel.push(...)` call sites are untouched: TOOLS orders and folds by
  section title, so a new tool section lands after the everyday ones.

`core/settings/store.js`: two comment blocks only (lines ~68-70, ~88-89).

## 5. For the coordinator

- **W1 (Kotlin):** please add `@JavascriptInterface fun hasLocationPermission():
Boolean = hasLocationPermission()` to `MainActivity.AndroidBridge`. JS already
  uses it when present; without it the app opens the GPS at launch only if this
  device has given a fix before (a revoked permission then prompts once, from
  `startNativeLocation(askPermission = true)`).
- **Battery:** once allowed, the phone's GPS now runs whenever Argus is in
  front (like a map app); it stops in the background as before.
- **W2 (core/nav/view.js):** its drag detector turns the route camera off on any
  pointer moving 10 px, so a two-finger pinch during a drive drops route follow
  (self-follow then takes over). Counting only single-pointer drags would keep
  route follow through a pinch.
- **Layer names (main.js registration):** "IR clouds" and "IR clouds (GOES)"
  read as duplicates; suggest "IR clouds (world)" / "IR clouds (Americas)".
  Not changed here to keep main.js edits in my blocks. Two stale comments
  there also say "VIEW > RECENT IMAGERY" (~line 1000) and "VIEW > SHODAN"
  (~1248).
- On the phone the TomTom road-speed readout (`mount('strip')`) lands at the top
  of TOOLS when switched on (VIEW > MORE > ROAD SPEED); left as it was.

## 6. Tests and checks

- `npm test`: 994 pass, 2 fail (propagate, occlusion: Cesium / satellite.js
  missing here, as expected).
- New tests: `follow.test.js` (8), selfPosition (6 new: startIfAllowed browser
  and app, stayLive, follow modes and hooks, auto-resume, driving moves),
  geoControl (rewritten for the new taps, plus pause, intercept, cell state).
- eslint (round config) and prettier clean on every changed file.
- Harness: all menus before and after on phone (412x915 @2x) and desktop
  (1600x900), splash on both; session memory still restores the regrouped VIEW
  switches (Intel HUD, Mono imagery) and layer options show only while their
  layer is on.

## 7. Not verified

- A real phone, the native GPS feed and a real drive (the harness pushes fixes
  and dispatches CDP touch events; swiftshader renders about one frame a second,
  so smoothness was judged from camera state, not motion).
- The Android WebView's answer to `navigator.permissions` (the app path uses the
  bridge or the stored flag instead).
- iOS compass permission (ALLOW for COMPASS) and Samsung Internet.
- Android Auto: untouched (the car keeps its own follow; `render` is off there).
