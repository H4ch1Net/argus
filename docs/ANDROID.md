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

| Permission                 | Why                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| Location (while in use)    | Around Me, the GEO button, satellite passes, and your position on the car map. Optional. |
| Internet, network state    | The proxy on the phone reaches the public feeds; the page reaches the proxy.             |
| Android Auto map templates | Declared so the app can draw its own map in the car (no prompt).                         |
| Car information            | The car's make, model, fuel, range, odometer and speed for the VEHICLE panel. Optional.  |

Location is asked the first time the globe (or the car) needs it; the car's
information (Android Auto's fuel, mileage and speed permissions) once, the
first time Argus opens in the car. There is no background location, no
notification, no storage permission (scene import uses the system file
picker), and Argus itself needs no Google Play services.

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

### One-time setup (unknown sources)

Android Auto hides apps that did not come from the Play Store until you allow
them:

1. On the phone, open Android Auto's settings: Settings, Connected devices,
   Connection preferences, **Android Auto** (or search Settings for "Android
   Auto"; on older phones it is the Android Auto app).
2. Scroll to the bottom and tap **Version** (on some versions "Version and
   permission info") about **10 times**, until "Allow development settings?"
   appears. Tap OK.
3. Open the three-dot menu at the top right, **Developer settings**.
4. Turn on **Unknown sources**.
5. Connect the phone to the car (cable or wireless). Argus appears in the
   car's app launcher; if not, check Android Auto settings, **Customize
   launcher**.

The first time Argus opens in the car without location permission, the car
says to check the phone, and the phone asks for it (with the car information
permissions, asked once).

### Navigation

- **WHERE TO** (top right) opens a search bar. Before you type it lists your
  last five destinations; type (or speak, when the car allows no keyboard
  while moving) and places near you appear, each with its distance and where
  it is. Tap one.
- **Route preview:** up to three routes, fastest first, each with its time,
  distance, the roads it takes, its traffic delay and the traffic lights on
  it; the map shows them (the selected one in white). **Avoid hwy** plans
  again without highways and freeways, and stays as you set it. **Navigate**
  starts the route.
- **On the route:** Android Auto's routing card shows the next maneuver
  (ctOS arrows), its distance and road, the one after, and the remaining
  distance, time and arrival. The map follows closer in, looks ahead along
  the route (round the next bend), and zooms in on the approach to a turn;
  the route ahead is white, what you have driven grey. Off the route it plans
  again on its own. **End** stops; on arrival it ends by itself after a
  while. The car's cluster display, where it has one, gets the same steps.
- Routes come from the same navigator as the globe on the phone, through the
  phone's proxy. If the car map reloads mid-route, it plans to the same place
  again and carries on.

### Vehicle

When the car stands still for three seconds (and is not on a route), a
**VEHICLE** panel slides in on the right: make, model and year, a silhouette
(sedan, SUV or EV, guessed from the car's fuels; set it in Settings), fuel and
battery level, range, odometer, and the average consumption since your last
fill-up (MPG, or L/100 km by region). It hides the moment you drive off.
Everything comes from the car through Android Auto (car API level 3 and up);
what a car does not report reads `--`. The average needs your tank size:
long-press the Argus icon, **Settings and keys**, **VEHICLE**, then drive
some distance after a fill-up.

### In the car

- **The view:** follows you, about 1.8 km above you when stopped, widening to
  about 6.5 km at motorway speed. Your position is the white chevron. **VIEW**
  (top right) cycles three views: **3D** (tilted 45 degrees, heading up), **2D**
  (straight down, heading up) and **North** (straight down, north up). The flat
  views are the lightest to draw. The choice is remembered.
- **Map buttons** (right side): pan, re-centre, zoom in, zoom out. Zooming
  while following changes the follow distance; dragging or panning switches to
  free look (MODE FREE); re-centre flies back and follows again.
- **LAYERS** (top right, beside WHERE TO and VIEW): two one-tap presets first, **Drive** (traffic
  incidents, CHP incidents, traffic cameras, surveillance and ALPR locations;
  the default) and **Sky** (aircraft overhead), then a switch for each layer.
  The list shows only layers this build can show: traffic incidents appear
  once the phone's proxy has a TomTom key. The choice is remembered.
- **Aircraft** are drawn on their ground track, like a radar scope: the car's
  camera looks down from below cruise altitude, so aircraft drawn at altitude
  would never be in view. Their flight level stays on their labels.
- **Touch screens:** drag to pan, pinch or double-tap to zoom, tap a contact to
  select it (its row turns green, marked 00).
- **Readouts:** top left, speed (large; km/h, or mph where the phone's region
  uses it), heading, view and mode. Bottom left, the selected contact and the
  nearest ones, **what is ahead first** (within 60 degrees of your course,
  marked with a white edge), each with range and an arrow showing where it
  lies on the map.

Driver-distraction rules shape the car screen: the map, the status strip and
the nearest-contacts readout (two rows on a route, none while you compare
routes), plus Android Auto's own search, route and routing-card screens. No
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

| Symptom                                                   | Fix                                                                                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Boot screen shows `ARGUS_BOOT : FAILED`                   | The reason and the proxy log are on that screen. **RESTART**; if it repeats, **SETTINGS** shows the full log (also `adb logcat -s ARGUS-NODE ArgusNode`). |
| "App not installed" when updating                         | The APK's signature changed (debug key): uninstall Argus, then install. Copy your keys out of Settings first.                                             |
| Argus missing in the car                                  | Android Auto developer settings, **Unknown sources** on; Customize launcher; disconnect and reconnect.                                                    |
| Car shows `ARGUS_BOOT : OPEN ARGUS ON THE PHONE`          | The proxy did not start: open Argus on the phone to see why.                                                                                              |
| Car map stays black or blank                              | Update **Android System WebView** (and Chrome) from the Play Store; reconnect. `adb logcat -s ArgusCar` shows the car page's messages.                    |
| No position (NO FIX)                                      | Location permission for Argus, and the phone's location on. In the car the phone's GPS is used.                                                           |
| Globe says NO PROXY REACHABLE                             | A proxy address set in SETUP (for a proxy on another machine) overrides the phone's own: clear it there.                                                  |
| A key does not take effect                                | Long-press the icon, **Restart proxy** (OpenSky and AISStream load at start).                                                                             |
| Scene export does nothing                                 | Downloads from the page are not supported inside the app; import works (system file picker). Use share links, or the browser version, to export.          |
| White globe, "WebGL unavailable" or hardware acceleration | Update Android System WebView; the app needs the GPU (OpenGL ES 3).                                                                                       |

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
the APK is then a workflow artifact).

Without signing secrets the APK is signed with a debug key. The workflow
caches that key so consecutive builds install over each other, but the cache
expires after about a week without builds; the next APK then has a new
signature and needs an uninstall first. To sign with your own key once and for
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
