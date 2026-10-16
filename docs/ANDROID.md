# Argus on Android: the app and Android Auto

One installable app with everything on the phone: the globe, the proxy that
holds your keys and reaches the feeds, and an Android Auto map for the car. No
laptop, no Termux, no Google Play services.

- [Install](#install)
- [Permissions](#permissions)
- [Keys](#keys)
- [Android Auto](#android-auto)
- [What runs where](#what-runs-where)
- [Battery and heat](#battery-and-heat)
- [Troubleshooting](#troubleshooting)
- [Building it yourself](#building-it-yourself)
- [Signing and releases](#signing-and-releases)

**Testing status.** The app was written without network access and has not yet
run on a phone or in a car: the GitHub workflow builds it, and the first real
runs are where it gets verified. The proxy entry it runs was checked on a
desktop Node with the same environment and files the app gives it, and the car
version's logic by unit tests; treat the rest as built, not live-tested (as in
[AUDIT.md](AUDIT.md)).

---

## Install

Needs Android 8.0 or newer on a 64-bit ARM phone (every current phone,
including the S25 Ultra).

1. On the phone, open the repository's releases page,
   `https://github.com/H4ch1Net/argus/releases`:
   - **Android (latest main)** (tag `android-latest`): `argus-android.apk`,
     rebuilt on every push to `main`;
   - or a numbered release (`v...`): `argus-v<version>.apk`.
2. Tap the APK. The first time, Android asks to let the browser install apps:
   allow it (Settings, Apps, Special access, Install unknown apps, your
   browser). Play Protect may warn about an unknown developer: Install anyway.
3. Open **Argus**. The first start unpacks the globe and the proxy (a few
   seconds, shown on the boot screen), then the globe loads. Later starts take
   a second or two.

**Updates:** download the newer APK and install it over the old one. If Android
says "App not installed" (the signature changed, see
[Signing](#signing-and-releases)), uninstall Argus first. Uninstalling deletes
its keys file, so copy your keys out of Settings before you do.

Long-press the Argus icon for three shortcuts: **Settings and keys**, **Full
screen on/off**, and **Restart proxy**.

## Permissions

| Permission                    | Why                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------- |
| Location (while in use)       | Around Me, the GEO button, satellite passes, and your position on the car map. Optional. |
| Foreground service (location) | Keeps your position coming to the car map while the phone is locked (no prompt).         |
| Internet, network state       | The proxy on the phone reaches the public feeds; the page reaches the proxy.             |
| Android Auto map templates    | Declared so the app can draw its own map in the car (no prompt).                         |
| Car information               | The car's make, model, fuel, range, odometer and speed for the VEHICLE strip. Optional.  |

Location is asked the first time the globe (or the car) needs it; the car's
information (Android Auto's fuel, mileage and speed permissions) once, the
first time Argus opens in the car. There is no background location
permission, no storage permission (scene import uses the system file picker),
and Argus itself needs no Google Play services.

While the car map runs, a quiet notification shows, **ARGUS : CAR MAP, using
location for the Android Auto map**. On the car display Android does not count
an app as in front, so without it a locked phone stops handing out positions
and the arrow stands still while you drive. It goes away when Argus leaves
the car screen for good. The car map also takes the **car's own GPS** through
Android Auto (it reaches Argus over the car connection, whatever the phone
thinks of the app), then Android's fused location, the phone's GPS and the
network, best first. Location runs for the whole time Argus is connected to
the car, also while another app is on the car screen, and if no position
comes for 15 seconds Argus asks every source again (then every 30, 60 and
120 seconds while nothing comes, as in a garage). **Settings and keys**,
**CAR GPS** shows the last drive: whether the notification's service
started, how many positions each source sent and how many were used, and
**FEED**: how often location started, stopped and was restarted, and how
often the map was hidden and shown; it is the first thing to look at if the
arrow ever stands still. Play may ask for a foreground service declaration for
this (Play Console, **App content**, **Foreground service permissions**:
`FOREGROUND_SERVICE_LOCATION`, use **Navigation**: it shows the driver's
position on the Android Auto map while driving).

## Keys

Every key is optional: with none you get the keyless feeds listed in the
[README](../README.md). Keys live in the app's private storage
(`files/argus/.env`, owner-only), are excluded from backups and device
transfer, and are read only by the proxy on the phone, never by the page.
Two ways to add them:

- **In the globe:** the **SETUP** tab in the bottom sheet lists every key the
  feeds can use and saves new ones to the same file. Most apply at once; the
  ones marked RESTART TO USE (OpenSky, AISStream) need **Restart proxy** (the
  long-press shortcut).
- **Natively:** long-press the icon, **Settings and keys** (also on the boot
  screen if the proxy fails). It edits the keys file directly, in the same
  `KEY=value` format as `.env.example` (pre-filled as a template), then **SAVE
  AND RESTART**. The screen is excluded from screenshots.

Which key unlocks what: [SETUP.md, Keys](../SETUP.md#3-keys).

## Android Auto

Argus is an Android Auto **navigation-category** app: its map is the globe, in
a car version built for a glance, and it navigates: search a place, pick a
route (traffic and traffic lights counted, highways avoided if you like), and
follow the turn-by-turn card. Parked, it shows your car's own readouts.

### One-time setup (Google Play internal testing)

Android Auto shows a navigation app in a real car only when it was installed
from Google Play. Its **Unknown sources** developer setting does not cover apps
built with the Android for Cars App Library, which every navigation app is
(Google's "Test Android apps for cars" page). The APK from the releases page
therefore runs on the phone but never appears in the car. Play's internal
testing track is the way in: private (only the testers you list), and no app
review for that track.

1. Set up the signing secrets ([Signing](#signing-and-releases)): the build
   then also makes `argus-android.aab`, the bundle Play takes, with your key as
   its upload key.
2. Create a Google Play Console developer account (a one-time fee) and, in it,
   an app with the package name `net.h4ch1.argus`.
3. **Advanced settings, Form factors**: add **Android Auto**.
4. **Test and release, Testing, Internal testing**: add yourself as a tester,
   create a release, drop in `argus-android.aab` (from the **android-latest**
   release, or the workflow run's artifact), and roll it out.
5. On the phone, open the tester link from that page, accept, and install
   Argus from the Play Store. Play signs its copy with its own key, so
   uninstall the copy from the releases page first (copy your keys out of
   Settings before you do).
6. Connect the phone to the car. Argus appears in the car's launcher (and in
   Android Auto settings, **Customize launcher**).

Each later update is a new internal testing release with the newer
`argus-android.aab` (Play needs a higher version code each time; the build
number provides it).

To try the car screen without a car, Google's Desktop Head Unit runs it on a
computer from the phone over USB.

The first time Argus opens in the car without location permission, the car
says to check the phone, and the phone asks for it (with the car information
permissions, asked once).

### Navigation

- **WHERE TO** (top right) opens a search bar. Before you type it lists your
  last five destinations; type (or speak, when the car allows no keyboard
  while moving) and places near you appear, each with its distance and where
  it is. Tap one. A kind of place ("gas", "coffee", "parking", "EV
  charging", "pharmacy") lists the nearest of that kind, from the map's own
  OpenStreetMap data.
- **Route preview:** up to three routes, fastest first, each with its time,
  distance, the roads it takes, its traffic delay and the traffic lights on
  it; the map shows them (the selected one in white). **Avoid hwy** plans
  again without highways and freeways, and stays as you set it. **Navigate**
  starts the route.
- **On the route:** Android Auto's routing card shows the next maneuver
  (ctOS arrows), its distance and road, the one after, and the remaining
  distance, time and arrival. The map follows closer in, keeps you in the
  middle beside the card, and zooms in on the approach to a turn; the route
  ahead is white, what you have driven grey. Off the route it plans
  again on its own. **End** stops; on arrival it ends by itself after a
  while. The car's cluster display, where it has one, gets the same steps.
- Routes come from the same navigator as the globe on the phone, through the
  phone's proxy. If the car map reloads mid-route, it plans to the same place
  again and carries on.

### Voice: Gemini and Google Assistant

Ask the phone's assistant (the car's microphone button, or "Hey Google")
while Argus is the map in the car, and Argus takes the place or the action;
the assistant does the listening and hands Argus the words, Argus never
records anything. If the assistant opens another map app instead, make Argus
its default navigation app where the phone offers it (Gemini or Google
Assistant settings, **Default navigation app**; Google documents the setting
as Settings, Google, Gemini, Default navigation app), and Android Auto may ask
which app to use the first time.

- **"Navigate to Walmart"**, **"take me to 46211 Jackson Street"**,
  **"navigate to the nearest gas station"**: the route shows and starts by
  itself when the match is clear (one place, or the best one within 80 km, or
  one with exactly that name close by). When it is not ("navigate to Los
  Angeles": many), the places are listed: tap one.
- **"Find coffee near me"**, **"gas stations nearby"**: the list, nearest
  first.
- **"Directions to ..."** shows the route without starting it; **"add a stop
  at ..."** does the same (Argus has no stops yet) and says so.
- While driving: **"what's my ETA"**, **"how far is it"**, **"what's my next
  turn"**, **"where am I going"**, **"what road am I on"**, **"show the route
  overview"**, **"follow me"**, **"avoid highways"** / **"allow highways"**
  (plans again), **"show traffic"** / **"hide traffic"** (the traffic flow
  layer, with a TomTom key), **"exit navigation"**. The answer shows on the
  car screen. What Argus does not do (tolls, ferries, reports, voice guidance)
  is said on the screen too.
- Started by the assistant, Argus opens in the car first and answers once the
  map is up (a few seconds).
- On the phone the same request opens WHERE TO with the matches, or the
  route to a point.

### Vehicle

When the car stands still for three seconds (and is not on a route), a small
**VEHICLE** strip shows at top left: fuel (or an electric
car's battery) with a thin meter, and the range; **LOW** in red when the car
says fuel is low. Tap it for a few seconds of the rest: make, model and year,
a hybrid's battery, odometer, and the average consumption since your last
fill-up (MPG, or L/100 km by region). It hides the moment you drive off, and
**LAYERS**, **VEHICLE INFO** turns it off for good. Everything comes from the
car through Android Auto (car API level 3 and up); what a car does not report
reads `--`. The average needs your tank size: long-press the Argus icon,
**Settings and keys**, **VEHICLE**, then drive some distance after a fill-up.

### In the car

- **The view:** follows you with your position (the white chevron) in the
  middle of the part of the screen Android Auto leaves free, beside the turn
  card while navigating; it does not jump when the buttons show or hide. The
  camera button (top right) steps through **AUTO** (tilted, heading up),
  **2D** (flat, turning with the car, heading up) and **NORTH** (flat, north
  up). All three zoom by themselves: about 1.8 km up when stopped, widening
  to about 6.5 km at motorway speed, and closer before a turn. The choice is
  remembered.
- **Map buttons** (right side): pan, **RECENTER** (the crosshair), zoom in,
  zoom out. Zooming while following changes the follow distance until
  RECENTER; dragging switches to free look, and the map follows you again by
  itself after ten seconds without a touch once you are driving; RECENTER
  flies back at once and puts you in the middle again.
- **LAYERS** (top right, beside WHERE TO and the camera button): the same
  layers as the phone, in six short groups so every one fits on any car
  screen: **TRAFFIC** (incidents, CHP, Waze, traffic flow, simulated traffic,
  traffic lights), **CAMERAS** (traffic cameras, public webcams, surveillance
  and ALPR locations), **AIRCRAFT** (flights, military), **WEATHER** (radar,
  lightning, fires, quakes), **PLACES** (your saved places, landmarks) and
  **DISPLAY**. Each group's row says which of its layers are on; open it for a
  switch per layer, each with its map glyph. The car shows the road-safe
  layers you left on in the phone app, and a switch here changes them for the
  phone too (it opens with them next time). A group lists only layers this
  build can show: traffic incidents and traffic flow appear once the phone's
  proxy has a TomTom key, fires once it has a NASA FIRMS key (phone app,
  **SETUP**). The header has two presets, **DRIVE** (traffic incidents, CHP
  incidents, traffic cameras, surveillance and ALPR locations) and the
  aircraft glyph for **Sky** (aircraft overhead). Before the phone app has
  ever run, the car starts with Drive.
- **DISPLAY** (the last LAYERS row): **SPEED** (the speed square), **ICON
  SIZE** (every map icon, 75 to 200 %; each press steps up, after 200 it
  starts again at 75) and **VEHICLE INFO**. ICON SIZE is the same setting as
  the phone's **SETTINGS**, **ICONS**: a change on either applies on the
  other at once, without a restart.
- **Android Auto draws** every button, list and card itself, in its own font
  and shapes (Google's rule for every car app). Argus sets everything it is
  allowed to, in ctOS: the glyphs (white), all text in capitals, the routing
  card's colour, the two accents (`CarAppTheme`: ctOS green for switches that
  are on, NAVIGATE and RETRY, grey second), END in red while navigating (car
  API level 4 and up), and red for a heavy traffic delay. Everything on the
  map is Argus's own, in ctOS.
- **Aircraft** are drawn on their ground track, like a radar scope: the car's
  camera looks down from below cruise altitude, so aircraft drawn at altitude
  would never be in view. Their flight level stays on their labels.
- **Touch screens:** drag to pan, pinch or double-tap to zoom, tap a contact to
  select it (its row turns green, marked 00).
- **Readouts:** bottom left of the free area, a small speed square (the car's
  own speedometer when Android Auto gives it, else the GPS; km/h, or mph
  where the phone's region uses it). It says **NO GPS** in red when no
  position has come for five seconds, rather than showing an old number.
  Beside it, the selected contact and the nearest ones, **what is ahead
  first** (within 60 degrees of your course, marked with a white edge), each
  with range and an arrow showing where it lies on the map.

Driver-distraction rules shape the car screen: the map, the speed square and
the nearest-contacts readout (two small rows, one on a route, none while
you compare routes), plus Android Auto's own search, route and routing-card screens. No
video, no camera stills, and only critical notices (a missing proxy, say);
feed errors stay on the phone.

### Performance

The car screen is drawn by the phone's GPU, beside whatever the phone itself
draws, so the car version is built to stay light:

- It always uses its own light look: the dark basemap, flat terrain, no sun
  lighting, atmosphere or stars, whatever the phone app is set to (the phone's
  choices, such as satellite imagery or photorealistic 3D tiles, never reach
  the car).
- It renders only what changed. The follow view updates 20 times a second on
  the move, 12 when creeping, and stops when you stop; standing still, GPS
  wander is held still, so a parked car with no aircraft on draws nothing.
  Aircraft move 8 times a second.
- The render target is held to about 1.1 million pixels whatever the car's
  screen, so a wide or dense display costs no more than a small one.
- Layers that load by area refetch when you have driven about a third of the
  view away (checked every 4 seconds), and not at all for GPS wander.
- Drags and pinches reach the map once per display frame, and the map pauses
  (no drawing, no polling, no location) whenever another app is in front on
  the car screen.
- The thermal ladder still applies: if frames slow down as the phone heats,
  the car lowers its resolution further.

### Trying it without a car

Android's **Desktop Head Unit** (DHU, in the Android SDK under Extras, "Android
Auto Desktop Head Unit Emulator") shows the car screen on a computer: in
Android Auto's developer settings start the head unit server, connect the
phone by USB, then `adb forward tcp:5277 tcp:5277` and run `desktop-head-unit`
from the SDK's `extras/google/auto` folder. The car version also runs in any
browser at `http://localhost:8787/?shell=car` (it then follows the browser's
own location, a drag on the globe leaves follow mode, and a route shows the
page's own maneuver banner instead of Android Auto's card).

## What runs where

```
 phone (one app, one process)
 ├─ Node 18 (nodejs-mobile), background thread
 │    the Argus proxy: keys, OAuth, feeds, websockets, budget governor
 │    + the built globe, both on http://127.0.0.1:8787 (next free port if busy)
 ├─ phone screen:  WebView -> http://127.0.0.1:<port>/            (mobile shell)
 └─ car screen:    WebView -> http://127.0.0.1:<port>/?shell=car  (car shell)
                    drawn on Android Auto's surface; gestures and the
                    phone's GPS are passed in by the app
```

- It is the same proxy and the same web app as `npm start`; the page treats
  `127.0.0.1` as a secure origin, so location and install-style features work
  without a certificate.
- The proxy listens on the phone only. **Settings, Share on Wi-Fi** opens it to
  the LAN (other devices can then use the globe at the phone's Wi-Fi address,
  and your keys' budgets): only on networks you trust.
- If Termux's `argus web` already holds port 8787, the app takes 8788 or the
  next free port. Each port is its own origin in the WebView, so settings and
  the last view are kept per port.
- Upstream requests go from the phone to the feeds directly (Node's own
  networking); the WebView itself only ever talks to `127.0.0.1`.

## Battery and heat

- Feeds poll only while the globe is on screen (Page Visibility); in the
  background the page pauses, and the proxy just waits. There is no background
  service: Android may close Argus while it is in the background, and the next
  start brings it back in a few seconds. No battery-optimisation exemption is
  needed.
- The screen stays on only in cockpit mode (the page asks; the app passes it
  on), and in the car (Android Auto keeps the phone awake while connected).
- The car map uses the lightest quality tier and about 1.25 device pixels per
  CSS pixel, because the phone's GPU draws it, sometimes alongside the phone's
  own globe. The thermal ladder backs quality off if the phone heats up.
- With the phone's own screen off while driving, only the car map renders.

## Troubleshooting

| Symptom                                                   | Fix                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot screen shows `ARGUS_BOOT : FAILED`                   | The reason and the proxy log are on that screen. **RESTART**; if it repeats, **SETTINGS** shows the full log (also `adb logcat -s ARGUS-NODE ArgusNode`).                                                                                                                           |
| "App not installed" when updating                         | The APK's signature changed (debug key): uninstall Argus, then install. Copy your keys out of Settings first.                                                                                                                                                                       |
| Argus missing in the car                                  | Android Auto only lists navigation apps installed from Google Play: install it through internal testing ([Android Auto](#android-auto)), then reconnect.                                                                                                                            |
| Car shows `ARGUS_BOOT : OPEN ARGUS ON THE PHONE`          | The proxy did not start: open Argus on the phone to see why.                                                                                                                                                                                                                        |
| Car map stays black or blank                              | Update **Android System WebView** (and Chrome) from the Play Store; reconnect. `adb logcat -s ArgusCar` shows the car page's messages.                                                                                                                                              |
| No position (NO FIX)                                      | Location permission for Argus, and the phone's location on. In the car the phone's GPS is used.                                                                                                                                                                                     |
| Gemini says it cannot navigate with Argus                 | Make Argus the **Default navigation app** (phone Settings, Google, Gemini or Google Assistant), then ask again in the car.                                                                                                                                                          |
| The car arrow stands still while driving                  | **Settings and keys**, **CAR GPS**: which sources sent positions, whether the service started, and FEED (restarts). Set Argus's battery use to **Unrestricted** (Android settings, Apps, Argus, Battery): Samsung's battery saver can hold location back. `adb logcat -s ArgusCar`. |
| Argus crashes                                             | The next start says **LAST CRASH** on the boot screen; **Settings**, **LAST CRASH**, **COPY** has the trace. Native crashes: `adb logcat -b crash -d`.                                                                                                                              |
| Globe says NO PROXY REACHABLE                             | A proxy address set in SETUP (for a proxy on another machine) overrides the phone's own: clear it there.                                                                                                                                                                            |
| A key does not take effect                                | Long-press the icon, **Restart proxy** (OpenSky and AISStream load at start).                                                                                                                                                                                                       |
| Scene export does nothing                                 | Downloads from the page are not supported inside the app; import works (system file picker). Use share links, or the browser version, to export.                                                                                                                                    |
| White globe, "WebGL unavailable" or hardware acceleration | Update Android System WebView; the app needs the GPU (OpenGL ES 3).                                                                                                                                                                                                                 |

## Building it yourself

Needs Node 22, JDK 17, and the Android SDK with platform 35, NDK
27.2.12479018 and CMake 3.22.1 (Android Studio's SDK Manager, or
`sdkmanager "platforms;android-35" "ndk;27.2.12479018" "cmake;3.22.1"`).

```bash
npm ci
npm run build                      # the web app, into dist/
node scripts/android-bundle.mjs    # dist/ + proxy/ + its runtime deps -> app assets
bash android/fetch-libnode.sh      # nodejs-mobile's libnode.so + headers
cd android
./gradlew assembleRelease          # -> app/build/outputs/apk/release/app-release.apk
# or, with a phone on USB:  ./gradlew installDebug
```

- The bundle script never stages a secret (`.env` files, keys, certificates are
  skipped and checked for); the staged project and `libnode` are gitignored.
- The APK is arm64 only by default. For the x86_64 emulator:
  `./gradlew assembleDebug -PargusAbis=arm64-v8a,x86_64`.
- Logs: `adb logcat -s ARGUS-NODE ArgusNode Argus ArgusCar` (Node's own output
  is `ARGUS-NODE`; the page's console is `Argus` and `ArgusCar`). Debug builds
  can be inspected from desktop Chrome at `chrome://inspect`.

Layout: `android/app/src/main/java/net/h4ch1/argus/` (`NodeRuntime.kt` unpacks
and starts Node and waits for `/health`; `MainActivity.kt` is the phone
WebView; `car/` is the Android Auto service, screens and the car surface
renderer), `android/app/src/main/cpp/` (the JNI bridge to `node::Start`),
`android/node/main.js` (the Node entry), `shell-car/` (the car web shell).

## Signing and releases

`.github/workflows/android.yml` builds on every push to `main` (the rolling
**android-latest** prerelease, `argus-android.apk`), on tags `v*` (that tag's
release, `argus-<tag>.apk`), and on demand (Actions, android, Run workflow:
the APK is then a workflow artifact). With the signing secrets below it also
builds the Google Play bundle beside each APK (`argus-android.aab`,
`argus-<tag>.aab`), signed with your key as Play's upload key; without them
there is no bundle, since Play refuses debug-signed uploads.

Without signing secrets the APK is signed with a debug key. The workflow
caches that key so consecutive builds install over each other, but the cache
expires after about a week without builds; the next APK then has a new
signature and needs an uninstall first. (Until Oct 2026 the cache never held
the key, so every build had a new one.) To sign with your own key once and for
all:

```bash
keytool -genkeypair -v -keystore argus-release.jks -alias argus \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 argus-release.jks > argus-release.jks.b64     # macOS: base64 -i argus-release.jks
```

Then on GitHub: the repository's Settings, Secrets and variables, Actions, New
repository secret, four times:

| Secret                      | Value                                   |
| --------------------------- | --------------------------------------- |
| `ANDROID_KEYSTORE_BASE64`   | the contents of `argus-release.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password                   |
| `ANDROID_KEY_ALIAS`         | `argus`                                 |
| `ANDROID_KEY_PASSWORD`      | the key password                        |

Keep `argus-release.jks` and its passwords somewhere safe and offline (losing
them means one more uninstall); never commit them. Moving from the debug key
to your own key needs one last uninstall.

The workflow also downloads nodejs-mobile (`NODEJS_MOBILE_VERSION`). Until its
checksum is pinned, every run prints the archive's sha256 as a warning: copy it
into `NODEJS_MOBILE_SHA256` in the workflow, and from then on a changed
download fails the build.
