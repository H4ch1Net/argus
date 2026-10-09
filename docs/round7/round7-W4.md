# Round 7, W4: session memory, local-first search, feed noise

Base: b08b5a9. Commits: ae32e67 (session memory), b472066 (local-first search),
3bafc66 (feed noise), plus this notes commit.

## 1. The app reopens as it was left

Owner: "When users exit the app and reopen it later it resets to default".

- `core/share/session.js` (new, pure): one record in localStorage,
  `argus.session.v1`: the view as a share hash (camera, layers, sensor, imagery,
  labels, target: `core/share/state.js`), the VIEW display controls that have no
  setting (Mono imagery, Viewport frame, Aircraft models, Starlink dense, CRT,
  Sharpen, Bloom, Intel HUD switches; Tracking boxes, Thermal palette, NVG gain
  choices), the webcam and traffic-camera filter chips, and the active preset
  with the view and layers it gives back (and the layers it staged, so a layer
  switched on by hand inside the preset survives leaving it). Decoding fails
  closed per field. `startPlan()` decides the launch: a link in the address bar
  wins; then the saved session ("Start in: where I left", now the default); else
  today's defaults (Around Me on the phone, the default layers on the desktop).
  The car never reads or writes the record. An older version's
  `argus.lastView` is read once as a fallback. `createSessionSaver()` saves on
  change, debounced 800 ms but never later than 5 s after the first change, and
  `flush()` writes at once.
- `core/ui/viewState.js` (new): reads and re-applies those controls by their
  visible label; applying presses the control as a person would, so its own
  handler does the work and repaints. Clean view and Orbit are momentary and not
  remembered; terrain, imagery, merge, sun/atmosphere/stars, previews, survScope
  already live in SETTINGS.
- Saving: camera moveEnd, layer changes, the target, any click in the page
  (capture listener), and `visibilitychange` (hidden), `pagehide` and `freeze`
  flush at once (the Android WebView may be killed in the background without an
  unload).
- SETTINGS > Start in: "Where I left" (default), "Default view", "Around me".
  `core/settings/store.js` migration: every save writes every key, so a record
  saved before this round holds the old default `'default'` explicitly; a record
  without the revision mark (`argus.settings.rev` = '2') takes `'last'` once; a
  choice made after that sticks.
- A resumed session leaves terrain to SETTINGS (applying the hash's terrain
  would have turned "auto" into an explicit choice); a link still sets it.

## 2. Local-first place and address search

Owner: "46211 Jackson street ... finds a jackson street in Cincinnati instead of
the one thats here in indio."

What the live answers showed (Oct 9 2026, all with curl, then through the real
proxy):

- Photon has the street but not that house number: biased near Indio it answers
  four Jackson Street segments in Indio and Coachella; biased near Cincinnati
  (39.1, -84.5) it answers Jackson Street, Cincinnati. So the phone's search was
  leaning on a view centre in the Ohio valley, not on the user (the launcher's
  geocoder had no bias at all; WHERE TO used the view centre whenever no fresh
  fix was in hand).
- US Census geocoder: "46211 Jackson street" alone finds nothing; with the state
  (", CA" or ", California") it answers 46211 JACKSON ST, INDIO, CA, 92201 at
  33.71306, -116.21643. With the wrong city (", Coachella, CA") nothing. A
  common address with only a state ("100 Main St, CA") answers 50 statewide.
- Nominatim has the address too, but with a bias box elsewhere (Cincinnati) the
  box fills the answer; it also answered this cloud host 429 several times.
- Photon's `location_bias_scale` / `zoom`: a stronger bias made "paris" lose
  Paris, France and "eiffel tower" lose Paris entirely; the default bias plus
  our own ranking is better, so they are not sent.

Built:

- `core/search/rank.js` (new, pure): text score (exact 1, starts with 0.95, all
  words 0.75 / 0.65, a share of 0.5; a house number the result lacks costs it),
  street words folded (street/st, avenue/ave, north/n ...), a bonus for a town
  or country named as typed (so "fresno" from Indio is the city, not a street
  named Fresno in Tijuana), less a distance penalty (square root to 0.3 at 300
  km, flat beyond, so among far results the provider's order stands). Same name
  within 200 m kept once.
- `core/search/census.js` (new): params and parsing for the Census geocoder.
- `core/search/region.js` (new): where the user is (city, state, country) from
  Photon's reverse geocoder, memoised per 0.1 degree for the session.
- `core/search/address.js` (new): `parseAddress` (house number first, a street
  word of 3+ letters; whether a state or ZIP is already there), the Census line
  (the user's state appended; a state-wide answer with nothing within 50 km asks
  again with the city), then Nominatim with a bias box around the user only when
  Census found no such number (or outside the US), and only once the query has
  stood still for 700 ms (a newer search or an abort cancels it: Nominatim's
  policy forbids type-ahead use).
- `core/nav/search.js` (WHERE TO and the car's SearchScreen via
  argusCar.search): asks the address path beside Photon/TomTom for numbered
  queries, ranks the network answers local first. US/CA/GB/IE/AU/NZ/FR Photon
  addresses now lead with the number ("83053 Avenue 48").
- `core/search/geocoder.js` (the search launcher and the terminal's geocode):
  the same address path and ranking.
- main.js: `searchNear` = the user's fix, else the last known one (a previous
  session's, up to a week), else the view centre; used by the launcher's
  geocoder and WHERE TO.
- Proxy (`proxy/feeds/nav.js`): new pinned feeds `census-geocoder` (path
  `/geocoder/locations/onelineaddress`; exactly address, benchmark
  Public_AR_Current, format json; 20/min, 1,000/day, cached a day, stale a
  week) and `photon-reverse` (`/reverse`; lat/lon to one decimal and limit=1;
  cached a day). `nominatim` now has its query keys pinned
  (`nominatimQueryOk`: search q/format/limit/addressdetails/viewbox, reverse
  lat/lon/format/zoom/addressdetails/accept-language; every caller checked:
  geocoder, reverseName, the cockpit briefing) and a cache (an hour, a day
  stale), and `/search` is exact (it allowed any suffix). No `\p{}`, no Intl.
- `core/credits.js`: the Census geocoder; Photon covers `photon-reverse`.
- Fixtures (real answers, Oct 9 2026; one feature named after a person dropped
  from the Cincinnati Photon answer): `core/nav/fixtures/photon-46211-jackson-indio.json`,
  `photon-jackson-cincinnati.json`, `photon-walmart-indio.json`,
  `photon-reverse-indio.json`, `photon-reverse-cincinnati.json`,
  `census-46211-jackson-ca.json`, `census-46211-jackson-ky.json`,
  `nominatim-46211-jackson-cincinnati.json`.

Live through the real proxy (scratchpad/W4/live-search.mjs), near Indio:
"46211 Jackson street" -> 46211 Jackson St, Indio, CA 92201 first, then the
local Jackson Streets; "walmart" -> the Coachella and Indio stores before Palm
Springs; "fresno" -> Fresno city; "paris" -> Paris, France (offline) first.

## 3. Feed noise

- Fires: `requires: 'firms'` in main.js's registry, so it is not offered until
  the proxy has FIRMS_MAP_KEY (harness: not offered against a keyless proxy).
- Waze (`core/layers/waze/source.js`): a 403 returns a quiet empty answer with
  the note "Waze refused (403); set LOCAL_WAZE_URL to your own waze-server", one
  WAZE REFUSED log entry, and no request for 30 minutes or until RELOAD
  (query.reload). Other failures are errors as before. The definition's and the
  terminal's statusNote show the note.
- LOGS (`core/ui/feedLog.js`, pure, replaces main.js's inline logger): a busy or
  failing source (429, 5xx, a timeout; a proxy "not configured" 502 is not
  busy) is one SOURCE BUSY line when it starts, not an ERR per poll; a recovery
  is logged only after an error, busy or stale, and only on a real answer:
  "BACK: N items", or "ANSWERING: no items here" when the view is empty. A tile
  layer's "zoom in to load" status is not an answer, so the old "DATA CENTRES
  BACK: 0 items" cannot happen.
- SDK tile path (`core/layers/sdk/createLayer.js`, tile code only): the error
  status carries the HTTP status; ok statuses say `answered` (poll: always;
  tiles: a tile answered in this view); a busy failure asks the view's failed
  tiles again once they cool down (61 s), even if the camera stays put.
- Overpass mirrors checked live (Oct 9 2026): the main instance gives an address
  two slots (its status page), VK answered 504 or timed out about half the time,
  kumi.systems (and private.coffee, same error page) answered 500 on every path
  including /api/status, hours after round 6 used it; no other public instance
  answered (nchc tunnel 502, openstreetmap.ru reset, openstreetmap.fr 403). The
  list stands; the comment in proxy/feeds.js says so. The relay's stale-if-error
  (7 days) already covers areas fetched before; it is in memory, so a restarted
  phone proxy has none (see below).

## main.js and settings blocks (for the merge)

- main.js 3083-3246: the session block (replaces the old share-link
  start/restore lines from `let hashTimer` to the overlay subscribe; encodeView
  above it is unchanged).
- main.js 1708-1718: the LOGS status logger (replaces the inline one).
- main.js 1574-1582: `searchNear` and `createGeocoder(proxyClient, { near })`;
  2529: the nav panel's `near: searchNear` (was the view centre inline).
- main.js 780-782: fires `requires: 'firms'`; 646: Waze gets `log`.
- core/settings/store.js 9-11 (rev constants), 27-29 (startView default and
  order), 120-134 (the one-time migration). core/ui/settingsPanel.js: the Start
  in labels.

## Tests

`npm test`: 929, 927 pass (the 2 failures are the expected Cesium /
satellite.js ones). `npm run test:proxy`: 173, 169 pass (the 4 ws ones). New:
core/share/session.test.js, core/search/rank.test.js,
core/search/address.test.js, core/ui/feedLog.test.js; added to
core/settings/store.test.js, core/nav/search.test.js (the owner's query with
the real answers, near Indio and biased to Cincinnati),
core/layers/waze/waze.test.js (the 403 hold), proxy/test/navFeeds.test.js (the
new pins). core/nav/navigator.test.js: the exact name now ranks first.
Lint (stand-in config) and prettier clean on every changed file.

## Harness checks (port 5213; scripts and shots in scratchpad/W4/)

- persist.cjs, desktop and phone, fresh device: first launch has the defaults
  (desktop flights/quakes/transit; phone Around Me with bikeshare); after
  changes (military on, transit off, camera to Indio 45 km, Intel HUD on, Mono
  off, Tracking boxes High, webcam chips, units imperial) a relaunch at the bare
  URL (as the Android app does, no hash) restores all of it; a change made just
  before the page closes is there (pagehide flush); the SKY preset stays
  highlighted after a relaunch and pressing it gives back the earlier layers and
  view plus the hand-added ships; "Start in: default view" ignores the session.
  ALL PASSED. Looked at mobile-after-relaunch.png (HUD back, camera where left).
- whereto.cjs (phone, real proxy, the fix in Indio, the view over Cincinnati):
  WHERE TO "46211 Jackson street" lists 46211 JACKSON ST, INDIO, CA 92201 at
  950 m first, then the local Jackson Streets (whereto-46211.png). The car shell
  afterwards starts at its own defaults, has no saver, and leaves the phone's
  record untouched after moving and toggling.
- feednoise.cjs (desktop, real keyless proxy, Indio): fires not offered; Waze:
  one WARN WAZE REFUSED line and the note in its status; Overpass layers loaded
  slowly but answered; no BACK lines.

## Not verified, and why

- The Android WebView itself: that visibilitychange/pagehide fire when the app
  is backgrounded, and that DOM storage survives a kill, could not be run here
  (the harness is Chromium). The debounce (at most 5 s) covers a kill that gives
  no event.
- Real Cesium: restore uses the same lookFrom as share links; checked on the
  stub only.
- A busy Overpass end to end in the browser (the tile retry and the SOURCE BUSY
  line) was unit-tested and reasoned, not forced live: the instances were slow
  but answering when the harness ran.
- Census for non-Indio addresses beyond the shapes tested; TomTom search ranking
  (no key here).
- The proxy's response cache is in memory: after the phone app restarts, an
  Overpass outage shows nothing for areas not fetched since. Persisting that
  cache to disk is a proxy change for later.
- In the harness the flights layer used OpenSky (its health probe through the
  explicit proxy base came back empty in the page, so the keyless fallback was
  not chosen); unrelated to this work, not chased.
