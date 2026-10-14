# Round 8, W2: intersections, road names, WHAT'S HERE, saved places

Base: 5cbaea5. Commits: c796ad9 (search), 7ac5798 (saved places, WHERE TO,
WHAT'S HERE), 68faab3 (car WHERE TO), 015d771 (fixes from the harness run),
plus this notes commit.

Owner: "I also tried to set the gps by looking up Highway 111 and Golf Center
pkway and it didnt find anything, also its very unintuitive saving your
favorite locations. Tapping and holding should have more stuff that makes
sense like save to my locations instead of just from here or to here."

## 1. Intersections

- `core/search/intersection.js` (new, pure): `parseIntersection` reads "A and
  B", "A & B", "A at B", "A / B", "A @ B", "A x B", "A + B", "corner of A and
  B" (also "intersection of"), with an optional ", Town" after B. `strong`
  when both sides read as streets (a street word, a route, a numbered avenue)
  or "corner of"; otherwise ("Lord and Taylor", "Monroe and Avenue 44") it is
  still tried, but its crossing only leads when no place result matches the
  query well (text score 0.75). The first separator that leaves two streets
  wins ("Avenue X & Main St").
- Matching: each side against every road line's names (name, name_en) and
  routes (ref split on ";", the OpenMapTiles network, and names that are
  routes such as "CA- 111"). 1 = the road, 0.7 = a variant (no street word
  typed, "Monroe" for Monroe Street; another street word; "Avenue 44" for
  "44th Avenue"; an old alignment or business loop of the route); the last
  typed word may be half typed (live as you type).
- Geometry: in a local metre plane around the user: segment crossings, plus an
  end of one road within 35 m of the other (the tiles' lines are simplified
  and stop where a name stops: Avenue 44 ends 23 m short of Monroe Street in
  the Oct 2026 tiles). Points within 90 m are one junction (divided roads
  cross twice); a crossing of the road itself hides weaker variant crossings
  (I-10 against its business loop, Indio Boulevard). Up to 3, best match then
  nearest.
- Source: `core/search/roadTiles.js` (new): the basemap's own vector tiles,
  OpenFreeMap z14 through the existing proxy feeds `openfreemap` (TileJSON,
  current tile set) and `openfreemap-tiles`, decoded with the basemap's
  `core/scene/vector/mvt.js` (only `transportation_name`: name, name_en, ref,
  network, class). Rings around the user: 3x3, then 5x5, then 7x7 tiles
  (about 6, 10, 14 km), stopping at the first ring with a crossing; tiles are
  kept decoded (64, least recently used out) and never cancelled mid way, so
  type-ahead reuses them; the proxy caches them a week too.
- Fallback: Overpass (existing `overpass` feed; it pins only the path, so no
  proxy change): ways around the user (8 km) whose name or ref matches each
  side, `node(w.a)(w.b)`, for clear intersections only (never "Lord and
  Taylor", so typing a name with "and" never spends Overpass budget).
- Injected: `lookupIntersection(parsed, { near, loadRoads, proxyClient })`;
  core/search stays Cesium-free and testable (the loader is a function).
- Result Place: `{ id: 'x:lat,lon', name: 'Highway 111 & Golf Center Parkway',
detail: 'Indio, California', kind: 'intersection' }`. A route side is shown
  as a sign says it (Highway 111, I-10, CA 111, I-10 Business); a name side by
  the road's own name (Golf Center Parkway). The town is a Photon reverse at
  the crossing (`core/search/reverse.js`), given at most 1.5 s.
- A found crossing does not wait for a slow place search: 1.2 s grace, then
  whatever Photon has said (while this was tested Photon answered 502 after
  15 s for a while, Oct 14 2026).
- Wired into the navigator (WHERE TO, the car through shell-car's search) and
  `createGeocoder` (the search launcher). The terminal's geocoder
  (shell-terminal/backend.js) is created without `near`, so `argus geocode`
  does not do intersections yet (see "For the coordinator").

## 2. Road aliases and street words

`core/search/roads.js` (new, pure), used by the intersection matcher and by
`core/search/rank.js` (placeTokens now = foldRoutes(foldStreet(...))):

- Street words, every spelling to one: pkway/pky/pwy/parkway = pkwy,
  blvd/boulevard/boul, dr/drive, ave/av/avenue, st/street/str, rd/road,
  ln/lane, ct/court, pl/place, hwy/highway, fwy/freeway, expy/expressway,
  tpke, ter, cir, trl, mt, ft, and n/s/e/w/ne/nw/se/sw.
- Routes: Highway / Hwy / Route / Rte 111 (any type), SR / SH / State Route /
  State Highway / CA / CA- 111 (a state route; state codes that are words or
  street abbreviations are not prefixes: NE 5 is not Nebraska), I-10 / I 10 /
  Interstate 10 / IH 10 / i10, US 99 / U.S. 99 / US Highway 99, County Road;
  qualifiers (Old, Hist, Bus/Business, Alt, Byp, Truck, Spur) make a variant.
  In ranking every form folds to one token ("rt111"), so "Highway 111"
  matches "CA 111"; a ZIP after a state is not a route.
- Tests with the real Indio names (Golf Center Parkway, CA 111 / CA- 111 /
  "CA 111 Old", Jackson Street, Monroe Street, Indio Boulevard with "CA 111
  Old;I 10 BUS;US 99 Hist", Avenue 44 / 44th Avenue, I-10 as ref 10 in
  us-interstate).

## 3. WHAT'S HERE (long press on the phone, right click on the desktop)

`core/ui/navPanel.js` (map press section), Pointer Events only (unchanged
detection: 550 ms touch/pen hold, or a right click):

- Header: the coordinates at once ("LOOKING UP"), then the name and town from
  Photon reverse (`photon-reverse` widened to five decimals, see proxy), else
  Nominatim's reverse (`nav.reverse`) when Photon has nothing or is down.
  A white marker on the pressed point while the sheet is open.
- Actions, a 2-column grid: SAVE (one tap, with the name as it is; once saved
  the title becomes the name field, edited in place, and HOME / WORK appear
  next to SAVED; SAVED again forgets it), ROUTE HERE, FROM HERE, COPY (the
  coordinates; async clipboard, else a hidden field), SHARE (navigator.share
  on touch, else copy; the app's own link to that point, or an OpenStreetMap
  link when served on loopback, as in the Android app), MEASURE (the next tap:
  a dashed line, the distance in the user's units and the bearing, as a label
  and a notification; the next long press or Esc clears it).
- Saving turns the My places layer on (main.js `onSaved`), so the place shows.
- NEARBY was left out: the LANDMARKS tool centres on the view and is not cheap
  to point elsewhere from here.

## 4. One saved-places model

There was already one store, `core/places/saved.js` (`argus.places.v1`:
TOOLS > MY PLACES, the My places layer, the search launcher, LANDMARKS >
SAVE). Kept and extended; no new store for favourites:

- HOME and WORK are kinds held by one place each (`setRole`, `role`; a new
  HOME makes the old one a plain place; an imported HOME never takes the
  role); `near(lat, lon, 30 m)` says whether a point is saved; `search('home')`
  finds HOME; `refresh()` and the window `storage` event read again what the
  other page (phone or car) changed.
- `core/places/recents.js` (new, `argus.recents.v1`, 12, newest first, the
  same place once within 50 m): where routes were planned to. The navigator
  records every successful plan (phone and car), but not a moving target; a
  dropped pin is kept by its coordinates until it gets a name.
- WHERE TO (`core/ui/navPanel.js`): before typing, SAVED (HOME, WORK, then the
  saved places nearest first, 6 shown, "ALL SAVED (n)"), RECENT (CLEAR), then
  PICK ON THE MAP / TARGET. EDIT on the SAVED line: HOME, WORK, REN (rename in
  the row), x; DONE. Typing: saved matches first, then crossings and places;
  every row has the save toggle (a hollow diamond, filled when saved: the My
  places mark), and so does the route preview's destination.
- TOOLS > MY PLACES (`core/ui/placesTool.js`): the kind picker and the
  window.prompt rename are gone; rows have HOME, WORK, REN (in place), x;
  SAVE VIEW / PICK ON MAP and EXPORT / IMPORT stay (the JSON export is the way
  to move places between devices; storage is per device).

## 5. Android Auto WHERE TO

`SearchScreen.kt`, `CarNav.kt` only (no bridge change, CarMapRenderer.kt
untouched): the screen asks the page `CarNav.SAVED_QUERY` ("@saved") through
the existing search channel each time it shows (onStart; one retry 2.5 s
later if the page is still starting). The navigator answers it with HOME
("Home", detail = its name), WORK, SAVED, then the page's recents (kinds
home / work / saved / recent); the screen adds the app's own Kotlin recents
it lacks. Own places use `ic_car_place`, recents `ic_car_recent`. A tap goes
to the route preview as before. shell-car/index.js needed no change: it
passes the query through to `nav.search`.

## Shared files (blocks)

- main.js 305-321: the saved-places block (createRecents beside
  createPlacesStore; the store takes `{ events: window }`).
- main.js 2535-2536: `createNavigator({ ..., places, recents })`.
- main.js 2573-2576: the nav panel import also imports `encodeShareHash`.
- main.js 2594-2610: `createNavPanel({ ..., places, recents, sketch,
shareLink, onSaved })`.
- proxy/feeds/nav.js: `photon-reverse` (lat/lon to five decimals, 20 a
  minute, 256 entries); proxy/test/navFeeds.test.js updated.
- core/settings/store.js, index.html: not touched.

## For the coordinator

- shell-terminal/backend.js: `createGeocoder(client)` has no `near`; pass the
  terminal map's centre (`createGeocoder(client, { near: () => centre })`) to
  give `argus geocode "A & B"` intersections.
- Android: if W1 adds HOME / WORK icons (res/drawable), SearchScreen.kt picks
  the icon per `p.kind` in one place (`own`); `R.string` was not touched
  (names come from the page: "Home", "Work").
- Android WebView has no `navigator.share`: SHARE copies the link instead. A
  native share would need a bridge method (W1's renderer / MainActivity).

## Tests

`npm test`: 1015, 1013 pass (the 2 expected Cesium / satellite.js ones).
`npm run test:proxy`: 176, 172 pass (the 4 ws ones). New:
core/search/roads.test.js, intersection.test.js (with
core/search/fixtures/indio-roads.json: 150 real road lines from the
OpenFreeMap tiles around Indio, Oct 14 2026), roadTiles.test.js (a small MVT
encoder), reverse.test.js (two real Photon reverse answers),
core/places/recents.test.js; added to core/places/saved.test.js,
core/nav/search.test.js, core/nav/navigator.test.js, core/search/rank.test.js,
core/search/geocoder.test.js. Lint (stand-in config) and prettier clean on
every changed file.

## Live checks (real proxy on 8802, fix in Indio 33.7206, -116.2156)

- Tiles and geometry, node (scratchpad/r8-W2/cross.mjs): "Highway 111 and
  Golf Center pkway" -> Highway 111 & Golf Center Parkway at 33.71491,
  -116.21028 (802 m; where Golf Center Parkway ends at 46th Avenue / Indio
  Boulevard, OSM ref "CA 111 Old"; Photon's bus stops "Hwy 111 at Golf Center
  Pkwy" are at 33.7151, -116.2106 and 33.7148, -116.2112, within 40 m);
  "Jackson St & Indio Blvd" -> 33.72064, -116.21622; "Monroe and Avenue 44"
  -> 33.72959, -116.23359; "I-10 & Golf Center Pkwy" -> 33.72603, -116.20149
  (the interchange); "Hwy 111 at Monroe St" -> 33.71448, -116.23381; "Lord and
  Taylor" -> none. First query 1.3 s (tiles from OpenFreeMap), then 10 to 25
  ms.
- Overpass fallback alone (overpass.mjs): the same crossing, 33.71491,
  -116.21030, in 33 s; the next two queries failed (502 timeout, ECONNRESET):
  Overpass was overloaded, which is why it is only the fallback.
- In the page (probe.cjs, real Cesium): the owner's query, Jackson & Indio
  Blvd and Monroe & Avenue 44 as above, with "Indio, California" once Photon
  reverse answered; "46211 Jackson street" -> 46211 Jackson St, Indio, CA
  92201 first; "fresno" -> Fresno city; "starbucks" -> the Indio and
  Coachella stores first. No regression.
- The car page (car.cjs, fake ArgusCarHost): "@saved" -> Home (46211 Jackson
  St, 0.5 mi), Work, Gym, the recent Jackson Street & Indio Boulevard; the
  owner's query -> the crossing; "home" -> Home.

## Harness screenshots (port 5402, scratchpad/r8-W2/shots), looked at

- Phone 412x915: 1-whats-here-at-once (coordinates, LOOKING UP, the 2x3
  grid, a white marker on the crossing), 2-whats-here-named (46TH AVENUE,
  INDIO, CALIFORNIA), 3-saved-sheet / 4-saved-home (name as an editable
  title, SAVED and HOME lit, the place on the map with its label),
  5-whereto-saved (SAVED: H HOME 800 M, INDIO FASHION MALL; RECENT; PICK ON THE
  MAP; filled and hollow diamonds), 6-whereto-edit (HOME / WORK / REN / x per
  row, DONE), 7-whereto-intersection (HIGHWAY 111 & GOLF CENTER PARKWAY,
  INDIO, CALIFORNIA, 800 M, filled: HOME is there), 8-preview (3 MIN 1.6 KM
  via Indio Boulevard, 46th Avenue; the destination's diamond).
- Desktop 1280x800: d1-right-click (TRANSPORTATION CENTER, INDIO), d2-measure
  (750 M 132 degrees: label and notification; the dashed line itself is faint
  on the software-rendered globe, as the draw tool's), d3/d4-my-places
  (rows with HOME / WORK / REN / x; rename and WORK moved as expected).

## Not verified, and why

- Android Auto and the Kotlin: not compiled here (no Android SDK); CI builds
  it. The car's list was checked only through the page's answer to "@saved".
- The phone WebView: long press with a real finger, the soft keyboard over
  WHERE TO, clipboard in the WebView (secure context on 127.0.0.1, so the
  async API should work; the fallback is a hidden field). The harness uses
  synthetic pointer events (they cause harmless setPointerCapture warnings).
- The car page and the phone page in two WebViews: the storage event between
  them is Chromium behaviour for one origin; the car also re-reads storage on
  every "@saved" (refresh), so a missed event costs nothing.
- Overpass fallback end to end in the app: unit-tested and run from node;
  in the app the tiles always answered.
- Places far from the user: crossings are searched around the user (or the
  view centre), up to about 7 km; an intersection in another city is found
  only when the map looks there.
