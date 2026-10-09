# Round 7, W2: icon size, scale with zoom, per-layer icons and variants

Owner's report: traffic lights and simulated cars stay a few pixels across at
street level (camera 150 to 400 m up); wants icons that grow when zoomed in (or
a fixed size, as now), a size setting, an advanced per-layer size and icon
choice, more ctOS variants, and a traffic light with a white outline and real
lamp colours.

## What was built

1. **Scale with zoom (default) or FIXED.** Every SDK point/billboard layer and
   the simulated traffic. Implemented with Cesium's `billboard.scaleByDistance`
   only: no per-frame or per-billboard work.
   - One NearFarScalar cannot both grow icons up close and shrink them toward the
     globe (Cesium evaluates `t^0.2` on squared distance, `czm_nearFarScalar`;
     checked in the 1.140 build), so there are two curves per layer: its own
     (unchanged, used for FIXED and when high) and a close-up curve rising from
     1x at 8 km to 3x at 100 m (2.64x at 150 m, 2.52x at 250 m, 2.40x at 400 m,
     2.13x at 1 km, 1.85x at 2 km, 1.48x at 4 km). Integration moved the far
     end from 5 km to 8 km so icons in the car's follow view (1.8 to 6.5 km up)
     also grow; the harness pixel sizes further down were measured with 5 km.
   - The close-up curve applies while the camera is below 30 km (back above
     40 km). At the swap every icon in view is at least the camera height away,
     and both curves are equal from 8 km to 150 km, so the swap is invisible.
     It rewrites each billboard's curve once.
   - Far away icons are never bigger than before (tested: from 8 km out the
     close-up curve equals the layer's own).
   - Layers with their own curve (transit, bikeshare) get a close-up curve built
     on theirs (`zoomCurve(base)`).
2. **Size.** Global `iconSize` (75 to 200%) and per layer `iconSize.<layer>` (50 to
   300%), multiplied into `billboard.scale`.
3. **Variants** (`iconVariant.<layer>`), drawn in core/ui/glyphs.js (white ink,
   dark keyline, layer tint):
   - signals: COLOUR (default, the owner's: same housing, white outline, red /
     amber / green lamps from `SIGNAL_LAMPS` in palette.js, drawn untinted),
     HEAD (the previous one), MAST (head on a mast arm), NODE (ctOS node square).
   - simtraffic: CAR (default, top-down car), ARROW, BOX, CLASSIC (previous).
     Heading-aligned as before. Base size 9 -> 11 px.
   - transit: CLASSIC (default), BOX, ARROW.
   - surveillance: DEVICE (default, per-kind silhouettes), BRACKET (ctOS camera
     brackets around a kind pictogram), BADGE (solid badge, pictogram knocked
     out); one glyph per kind in each family (`svb-*`, `svs-*`).
   - cctv: BRACKET (default), CAMERA, DOME. trafficcams: BRACKET, ROAD, CAMERA.
   - Untinted glyphs (`glyph().untinted`) are drawn white at the style's alpha, so
     the layer ink never washes out the colour signal.
   - Glyph canvases come in densities 2 (default), 3, 4 (`glyphDensity`), cached
     under their own atlas id (`argus-glyph-<name>@<d>`), so a grown icon is not
     a magnified 32 px canvas. The density is the same in both regimes (no image
     swap, so no atlas load or blink, at the curve swap).
4. **SETTINGS > ICONS** (new page): ICON SIZE (SCALE WITH ZOOM / FIXED), ALL
   ICONS (75..200%), PER-LAYER ICONS switch revealing one row per registered icon
   layer (menu order, grouped): live preview at its current size, a -/+ stepper,
   variant tiles with previews; RESET ICONS. Everything applies live (no reload).
5. **Selection overlay** (core/scene/trackingOverlay.js): scan boxes and the hub
   brackets grow to frame a grown icon (`layer.iconPx(target, cameraWC)`, computed
   at the overlay's 8 Hz pick, not per frame).
6. Menu tiles (core/ui/layerGlyphs.js) show each layer's DEFAULT variant (so the
   signals tile is the colour signal, simtraffic the car).
7. Fixed a latent dialog bug: the settings dialog grew past the viewport (off
   screen) when a page was taller than it (grid row sized to content); the ICONS
   list exposed it. `.ct-settings__backdrop { grid-template-rows: minmax(0, 1fr) }`.

## Files

- New: `core/ui/iconPrefs.js` (pure: registry, schema, curve math, policy),
  `core/ui/iconPrefs.test.js`, `core/ui/iconSettings.js` (ICONS page).
- `core/ui/glyphs.js` (variants, density, untinted), `core/ui/palette.js`
  (`SIGNAL_LAMPS`, additive), `core/ui/layerGlyphs.js` (default variant tiles).
- `core/layers/sdk/renderers.js` (point/billboard style + scale paths: look,
  `baseCurve`, untinted white), `core/layers/sdk/createLayer.js` (icon policy
  look, restyle on version change, `iconPx`).
- `core/layers/simtraffic/renderer.js` (look, restyle the pool on change).
- `core/scene/trackingOverlay.js` (box / hub size from `iconPx`).
- `core/ui/settingsPanel.js` (ICONS page, `layers` dep), `core/ui/settings.css`.

## Shared files

- `main.js`: one block at lines 261-266 (bind the scene's icon policy to the
  settings, right after the merge-nearby policy, every shell incl. the car) and
  one added line 2316 in the `createSettingsPanel({...})` call
  (`layers: () => manager.list()`).
- `core/settings/store.js`: import at line 8 and one block at lines 83-86
  (`...ICON_SETTINGS_SCHEMA` at the end of the schema). The keys use the store's
  own validation (default + allowed values), so validate, reset, export and
  import cover them with no store changes. 41 keys: `iconScaling`, `iconSize`,
  `iconSize.<layer>` x 33, `iconVariant.<layer>` x 6.

## Tests

- `core/ui/iconPrefs.test.js` (15): Cesium curve formula, close-up values at the
  owner's heights, no growth from 8 km out, seamless swap, hysteresis, simtraffic
  curve, size/variant look, every variant glyph exists and the surveillance
  families cover every kind, every icon layer registered in main.js with an ink,
  density steps, size stepper, schema validation of bad values, export/import
  and reset round trip, policy versioning, store binding.
- `npm test`: 909/911 pass; the 2 failures are the known Cesium-less files
  (propagate, occlusion). Lint (stand-in config) and prettier clean on every
  changed file.

## Harness checks (looked at every screenshot; scratchpad/W2/shots)

My own copy of the harness (scratchpad/W2/harness, port 5211). The shared stub
was NOT changed; my copy's `nearFar` was extended to Cesium's real formula
(Euclidean eye distance, t^0.2) so sizes are meaningful.

- Desktop 1600x900, camera 250 m, signals + surveillance + simtraffic:
  SCALE: signals 26 px, surveillance 32 px (max 36), cars 22 px; FIXED: 11 / 14 /
  9 px (as before). 1.5 km: 18 / 22 / 15 (zoom) vs 11 / 14 / 8 (fixed). 6 km and
  60 km: identical to fixed (clusters at 60 km still merge).
- Phone 412x915 dpr 2 touch, 200 and 400 m: 27 / 33 / 22 px vs 11 / 14 / 9 px;
  side by side in `mobile-zoom-vs-fixed-200.png`. Tapping the edge of a grown
  icon selects it; the hub brackets frame it (`sel-mobile-250.png`).
- SETTINGS > ICONS on desktop and phone (`ui-*-icons*.png`): MAST + 150% on
  signals applied live to the map, FIXED + 150% global, BADGE surveillance,
  export carries 41 icon keys, RESET ICONS restores defaults and repaints.
- Every layer on, every variant and size swept: no errors (`all.cjs`).
- Car page (shell-car via main.js, 1536x576): no errors; its follow camera sits
  1.8 to 6.5 km up (4.7 km at 27 mph), so scale with zoom adds little there
  (by design: far views keep today's size). The car uses the phone's saved icon
  settings (same origin); it has no settings UI of its own.
- **Real CesiumJS 1.140** (the build in scratchpad/realcesium, swiftshader,
  `W2/real/`): three 11 px billboards 300 m below the camera measured 11 px with
  the layer's own curve, 26 px with the close-up curve, and 26 px after swapping
  the curve at runtime (the regime switch path).

## Not verified / open

- Not run on the phone or a real GPU; the real-Cesium check covers only the
  curve mechanism, not the app. Texture filtering of density 3/4 glyphs when
  small (no mipmaps in Cesium's atlas) looked fine in a 2D canvas only.
- The layer menu tile shows the default variant, not the one chosen (the menu
  is built once; follow-up if wanted).
- Terminal shell: not applicable (braille map, no icon sizes).
- Decision for the coordinator: the colour signal is the DEFAULT signals icon
  (the owner asked for it); one constant (variant order in
  `core/ui/iconPrefs.js`) flips it back to HEAD.
