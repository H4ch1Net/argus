# Round 7, W3: two-finger gestures

Owner (S25 Ultra, Android app): "the rotating and manipulation of the map is janky too,
i try to rotate with two fingers and randomly snaps to random rotations and just janks a
lot and vibrates, theres no resistance or accidental touch handling, and needs to be
smoother."

## Why it janked (Cesium 1.140, read from source)

- Cesium's `PINCH` event type sits in both `zoomEventTypes` and `tiltEventTypes`, so
  every two-finger move zoomed, twisted and tilted at once from the same fingers (a
  pinch also turned and tipped the map). No dead zones.
- Its twist is `atan2` of the finger line, frame to frame, unwrapped nowhere: when the
  line passes level with the second finger on the left (+180 to -180), the delta is a
  whole turn. That is the "snaps to random rotations".
- A one-finger drag that a second finger interrupts is ended by Cesium as a fling
  (press under 0.4 s), so the pan glided on under the pinch.
- The phone renders at its 30 fps ambient cap during gestures.
- Nothing in the code calls `navigator.vibrate` (none in JS, no haptics in the Kotlin).
  "Vibrates" reads as the visual shaking above; long-press haptics were already
  prevented (`navPanel.js` cancels `contextmenu` on the canvas).

## What it does now

Two-finger touch gestures are ours; one-finger pan, the mouse, the wheel, the trackpad
pinch (ctrl+wheel) and Android Auto's `argusCar.zoom` / `pan` / `tap` are unchanged.

| Gesture | Engages when                                                                 | Then                                                         |
| ------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Pinch   | spacing changed by 6 % of where it started, at least 12 px                   | scale follows the spacing from there, about the midpoint     |
| Twist   | finger line turned 14 degrees (22 once a pinch is under way)                 | turns 1:1 from the engagement angle (no jump), unwrapped     |
| Tilt    | both fingers 20 px up or down the same way, side by side, angle within 8 deg | exclusive: pinch and twist locked out until the fingers lift |

- Pinch and twist combine once both are engaged. Fingers closer than 48 px never
  twist (their angle is noise); a twist in progress holds while they are that close.
- Zoom keeps the ground under the fingers' midpoint under it; twist turns about the
  vertical through that ground point; tilt turns about a level axis through the ground
  at the screen centre. Following a target (FOLLOW), all three use the target instead.
- Smoothing: spacing, angle (as arc length) and midpoint go through a 1-euro filter
  (4 Hz at rest, opening with speed); changes under 0.35 px wait until they add up.
  The camera moves once per rendered frame, in `scene.preRender` (pointer moves only
  request a render), so a frame shows the latest fingers with no extra latency.
- Glide: a pinch or twist released while moving glides on with a 110 ms time constant,
  capped (at most about +32 % zoom, about 12 degrees), never after a slow release or a
  tilt. Any new press anywhere, a wheel turn, or any other camera move stops it.
- Limits: height 20 m to 45,000 km (same envelope as Cesium's zoom limits), not nearer
  than 40 m to the pivot, tilt from straight down to 3 degrees above the horizon near
  the ground, steepening to 30 degrees below it from orbit (log-scaled 5 km to
  5,000 km); a view that is already shallower may only steepen.
- Accidental touches:
  - a palm (contact 80 CSS px or wider, about 13 mm; 0 or 1 means unknown) is stopped
    in the capture phase on the canvas' parent, so neither Cesium nor the picker nor
    the long-press ever sees it; a finger that spreads into a palm leaves the gesture;
  - a second finger that lands while a one-finger pan has travelled over 48 px and is
    still moving (moved in the last 150 ms) is a stray touch: stopped the same way,
    the pan carries on. A pan that came to rest first can become a pinch;
  - a third finger never joins the pair; when one of the pair lifts with two others
    down, those two start a new, undecided gesture (no jump);
  - a finger in the 24 px edge strips (Android's back gesture) can zoom but never
    twist or tilt;
  - `pointercancel`, page blur or hide end the gesture without a glide.
- No selection during or after a multi-touch gesture: the picker's own multi-pointer
  rule is unchanged, and stray touches never reach it.
- Frame cap: while a finger is on the map (or a glide runs) `viewer.targetFrameRate` is
  lifted from the phone's 30 to 60, and put back when the last finger lifts. Not done
  when the cap is already 60 or more (desktop), nor in the cockpit (inputs off); a
  boost that ends during the cockpit is undone when the cockpit hands the inputs back.

## Files

- `core/interaction/twoFinger.js` (new, pure, no Cesium or DOM): the recognizer
  (`createTwoFingerRecognizer`), the 1-euro filter, `wrapPi`, `createInertia`, the touch
  tracker (`createTouchTracker`: palm, stray finger, third finger, edge strips),
  `isPalmContact`, `inEdgeZone`, `isLateSecondFinger`, and the pose math
  (`rotateVector`, `orbitPose`, `slidePose`, `elevationOf`, `levelAxis`,
  `maxTiltElevation`, `tiltPerPx`).
- `core/interaction/twoFinger.test.js` (new, 27 tests).
- `core/interaction/cameraInput.js`: the driver (`attachTouchGestures`, internal);
  removes `CameraEventType.PINCH` from the controller's event types (restored on
  destroy), stops Cesium's drag glide when a second finger lands, the frame-cap boost.
  The round-6 zoom-factor hack is gone. `tuneCameraInput(viewer, camera)` keeps its
  signature; without camera controls Cesium keeps its own pinch.
- `core/scene/cameraControls.js`: `beginGesture`, `pivotAt`, `zoomAbout`,
  `rotateAbout`, `tiltAbout` (instant rigid moves via `camera.setView` with
  direction/up), exports `CAMERA_MIN_HEIGHT_M` / `CAMERA_MAX_HEIGHT_M`.
- `core/interaction/gestures.js` (+ test): `pinchZoomFactor` removed (unused now).
- `core/interaction/picker.js`: header comment only.
- `SETUP.md`: the phone gesture sentence (pinch, twist, two-finger tilt, dead zones).

No changes to `main.js` or `core/settings/store.js` (main.js lines 254 to 258 already
call `tuneCameraInput(app.viewer, camera)`), none to `shell-car`.

## Tests, lint, format

- `npm test`: 920 of 922 pass; the 2 failures are the known missing-package ones
  (satellites/propagate, scene/occlusion).
- New unit tests feed synthetic finger tracks (16 ms frames): pure pinch (zooms about
  2.6x for 100 to 300 px, no rotation or tilt, rests settle), pinch in, twist under the
  threshold (nothing), twist past it (46 of 60 degrees, first step under 2.5 degrees,
  never more than a frame's turn), counter-clockwise twist, parallel vertical drag
  (tilt only), tilt locks out a later twist and pinch, vertical-stacked fingers do not
  tilt, noisy pinch (5 seeds, +-2 px jitter and a 4 degree wobble: never rotates),
  resting fingers with sensor noise (nothing moves), wrap-around across 180 degrees
  and a 400 degree spin, pinch plus twist combined, edge strips, fingers almost
  touching, release speed (fling vs rested), glide (short, capped, slow releases do
  not glide), the tracker (third finger, palm, finger growing into a palm, stray
  finger during a pan vs a pan at rest, leftover finger re-pairs, edge flags), and the
  pose math (pivot stays put, tilt raises the view by exactly the angle and keeps the
  pivot ahead, slide, tilt limit).
- eslint (scratch config) and prettier clean on every file touched; no em dashes.

## Harness (stub Cesium, headless Chromium, phone layout 412x915 dpr 2 touch)

Real touch input through CDP `Input.dispatchTouchEvent` (trusted pointer events);
the camera (heading, pitch, height, lat) is recorded at every rendered frame.
Scripts in `scratchpad/W3/`: `gestures.cjs` (the checks below), `mobile6.cjs` and
`desk6.cjs` (round 6's phone and desktop checks re-run on this build),
`cluster.cjs`, `probe.cjs` (CDP touch semantics). Result: 34 of 34.

| Check                                        | Measured                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A pinch 100 to 300 px                        | 60,000 to 22,408 m (x2.68), heading range 0, pitch steady, max step x1.05                                             |
| A ground under the fingers stays put         | anchor reprojects to (206, 450), the midpoint                                                                         |
| B noisy pinch (+-2 px, 5 degree wobble)      | heading range 0, zooms                                                                                                |
| C twist 10 degrees                           | no rotation, no zoom                                                                                                  |
| D twist 60 degrees                           | heading 0 to -45.8, first step 0.43 to 0.50 degrees, max 1.2 per frame, no zoom, pivot stays at (206, 450)            |
| E two fingers up 200 px                      | pitch -90 to -54.3, heading range 0, max 1.0 degree per frame; back down 250 px returns to exactly -90                |
| F twist 170 to 220 degrees (across the wrap) | heading turns 35.9, max step 1.35 (no full-turn snap)                                                                 |
| G third finger joins, first finger lifts     | heading steady, no jump at the lift (height unchanged while the new pair is undecided)                                |
| H palm (radius 60) during a pan              | 1 pointerdown reaches the canvas, pan continues, no zoom or turn                                                      |
| I stray finger late in a fast pan            | ignored (1 canvas press), no zoom or turn                                                                             |
| J finger in the edge strip                   | a 60 degree twist does not rotate; a pinch still zooms x2.1                                                           |
| K fling                                      | glides x1.12 after release then stops; a new touch stops a glide at once; frame cap 30 to 60 while touching, 30 after |
| L selection after all of the above           | none                                                                                                                  |

Per-frame traces (frame: heading / pitch / height), every 5th frame:

- Twist 60: `25: 0.0/-90/60000  30: 0.0  35: -2.0  40: -4.9  45: -7.5 ... 120: -45.5  130: -45.8`
  (first change at frame 31: -0.42 degrees).
- Tilt: `5: -90.0/60000  10: -89.7/59999  15: -87.5  20: -85.6 ... 110: -55.0/49040  120: -54.4/48676`, heading 0 throughout.
- Pinch: heading 0 and pitch -90 at every frame; height 60000, 56631, 50882, 46469 ... 22572.

Round 6 re-run on this build: double tap x2 in (300 to 150 km) and triple tap x2 out,
pinch never selects, cluster tap flies in (3 runs: 8,000 km to 0.7 to 1.3 Mm; one
earlier miss was a moving flight group that drifted under the top bar), desktop
double / triple click, pick priority, click selects in 60 ms, click on the map
deselects after the double-tap window. The desktop "RELOAD refetches the view" check
fails the same way before any gesture (the surveillance layer reports 0 tiles from the
start with this build's mocks): tile cache, not gestures.

Screenshots looked at: `scratchpad/W3/shots/twist-before.png`, `twist-after.png` (the
map turned clockwise about the fingers), `tilt-after.png` (oblique). A "THERMAL BUDGET"
toast in the tilt shot is the stub's slow 2D drawing on this loaded machine (the stub
has no frame cap, so the boost is not active there).

Stub changes (minimal, in my copy only: `scratchpad/W3/harness/browser/cesium.js`, diff
in `scratchpad/W3/stub.diff`; the shared stub is untouched so other workers' runs are
not disturbed): `camera.setView` accepts `orientation: { direction, up }` (converted to
heading / pitch in the destination's east-north-up frame, as Cesium does), and its
drag follows only its own pointer and stops when a second touch lands until every
touch lifts (as Cesium's handler does with the pinch taken away).

## Not verified here, and why

- Real Cesium and a GPU: removing `PINCH` from the event types, the private inertia
  states (`_lastInertia*Movement.inertiaEnabled`, Cesium 1.140 names, guarded),
  `setView` with direction/up while FOLLOW's EntityView owns the transform (the pivot
  is then the target), terrain collision after a tilt, `globe.pick` for the pivot:
  read from the 1.140 sources, run only against the stub (which has no controller, no
  transforms and a sphere).
- A real phone: the feel at 120 Hz touch / 60 fps, the dead zones and filter
  constants, Samsung's reported contact sizes (the 80 px palm threshold), the edge
  strips against Android's back gesture, Samsung Internet. The harness steps CDP
  touches at about 10 per second on this machine, so its "fling" is a slow pinch.
- The thermal ladder with the boost: see below.

## For the coordinator

- Decision: the 60 fps boost while fingers are down. CLAUDE.md caps the phone at 30
  "ambient"; this lifts it only during touch interaction (and the glide). It is one
  constant (`GESTURE_FPS` in `cameraInput.js`). The thermal ladder judges frames against
  the live cap, so on a phone that cannot hold 60, 8 s or more of continuous gesturing
  could step quality down; if that matters, `core/scene/thermal.js` could judge against
  the profile's own cap (not my file, not changed).
- One finger left after a two-finger gesture stays inert until it lifts (Cesium's
  behaviour too); Google Maps pans with it. Possible follow-up.
- `README.md` row "Wheel, pinch, + / -" still reads correctly; `docs/round6/round6-A.md`
  section 3's pinch zoom-factor paragraph is superseded by this (history, not edited).
- The picker forgets presses older than 5 s, so a third-finger tap during a pinch held
  longer than that could select. Rare; not changed.
