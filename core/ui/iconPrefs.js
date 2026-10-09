// Map icon size and variants (SETTINGS > ICONS). Pure data and math, no
// Cesium and no DOM: the settings store, the settings panel, the Layer SDK's
// billboard path (core/layers/sdk/renderers.js, createLayer.js) and the
// simulated traffic renderer all read it, and the tests run it in Node.
//
// Three knobs:
//   scaling  'zoom' (default): icons grow as the camera comes down to street
//            level (up to about 2.5x a few hundred metres up, 3x at 100 m) and
//            are never bigger than before from far away; 'fixed': a constant
//            screen size, as before.
//   size     a global multiplier (75% to 200%).
//   per layer a size multiplier (50% to 300%) and, where a layer has them, an
//            icon variant (core/ui/glyphs.js draws them all in the ctOS idiom).
//
// How "scale with zoom" works without per-frame work: every billboard has a
// distance curve (Cesium's scaleByDistance, a NearFarScalar the GPU evaluates
// per vertex). A single curve cannot both grow icons up close and shrink them
// toward the whole-Earth view (Cesium interpolates with t^0.2, far too slow a
// fall-off), so there are two: the layer's own curve, as before, and a
// close-up curve that rises from 1x at 5 km to 3x at 100 m. The close-up curve
// applies while the camera is low (below 30 km, back above 40 km), where every
// icon in view is closer than 150 km and the layer's own curve is flat at its
// near value, so swapping curves at that height changes nothing on screen.
// The swap rewrites each billboard's curve once, never per frame.

/** Icon scaling modes: grow with zoom, or a constant screen size. */
export const ICON_SCALING = Object.freeze(['zoom', 'fixed']);
/** Global icon size, percent. */
export const ICON_SIZES = Object.freeze([75, 100, 125, 150, 200]);
/** Per-layer icon size, percent. */
export const LAYER_SIZES = Object.freeze([50, 75, 100, 125, 150, 200, 250, 300]);

/**
 * The close-up curve: nearValue at nearM, 1x (the layer's own value) from
 * farM out; it applies below enterM and stops above leaveM camera height.
 */
export const ZOOM = Object.freeze({
  nearM: 100,
  max: 3,
  farM: 5000,
  enterM: 30_000,
  leaveM: 40_000,
});

const v = (id, label, glyphs = {}) => Object.freeze({ id, label, glyphs });

// Surveillance families: the same kinds (core/layers/surveillance/kinds.js)
// as ctOS bracket marks or solid badges, one glyph per kind.
const SURV_GLYPHS = [
  'alpr',
  'acoustic',
  'redlight',
  'speedcam',
  'cam-fixed',
  'cam-dome',
  'cam-ptz',
  'guardpost',
];
const family = (prefix) =>
  Object.fromEntries(SURV_GLYPHS.map((g) => [g, `${prefix}-${g}`]));

// Road vehicles, heading up (simulated traffic, transit).
const VEHICLE = {
  car: v('car', 'CAR', { vehicle: 'car-top' }),
  arrow: v('arrow', 'ARROW', { vehicle: 'car-arrow' }),
  box: v('box', 'BOX', { vehicle: 'car-box' }),
  classic: v('classic', 'CLASSIC'),
};

/**
 * Every layer that draws icons, in no particular order (the panel lists them
 * in the layer menu's order). key: the layer manager's key; glyph: the
 * layer's main glyph (core/ui/glyphs.js) for previews; px: its usual size in
 * CSS px; variants: alternatives, the first (or def) the default, each
 * mapping the layer's own glyph names to the variant's (unmapped names stay).
 */
export const ICON_LAYERS = Object.freeze(
  [
    { key: 'flights', glyph: 'airliner', px: 20 },
    { key: 'military', glyph: 'fastjet', px: 20 },
    { key: 'localadsb', glyph: 'light', px: 18 },
    { key: 'satellites', glyph: 'sat', px: 13 },
    { key: 'constellations', glyph: 'square', px: 6 },
    { key: 'launches', glyph: 'cross', px: 12 },
    {
      key: 'transit',
      glyph: 'vehicle',
      px: 12,
      variants: [VEHICLE.classic, VEHICLE.box, VEHICLE.arrow],
    },
    { key: 'bikeshare', glyph: 'square', px: 9 },
    {
      key: 'signals',
      glyph: 'signal',
      px: 11,
      // The owner's colour signal (white housing, real lamp colours) first.
      variants: [
        v('color', 'COLOUR', { signal: 'signal-color' }),
        v('head', 'HEAD'),
        v('arm', 'MAST', { signal: 'signal-arm' }),
        v('node', 'NODE', { signal: 'signal-node' }),
      ],
    },
    { key: 'incidents', glyph: 'xmark', px: 13 },
    { key: 'chp', glyph: 'triangle', px: 12 },
    { key: 'waze', glyph: 'report', px: 13 },
    { key: 'borderwaits', glyph: 'gate', px: 13 },
    {
      key: 'simtraffic',
      glyph: 'vehicle',
      px: 11,
      variants: [VEHICLE.car, VEHICLE.arrow, VEHICLE.box, VEHICLE.classic],
    },
    { key: 'streetphotos', glyph: 'photo', px: 12 },
    { key: 'ships', glyph: 'hull', px: 13 },
    { key: 'quakes', glyph: 'pulse', px: 14 },
    { key: 'fires', glyph: 'triangle', px: 11 },
    { key: 'cyclones', glyph: 'diamond', px: 16 },
    {
      key: 'surveillance',
      glyph: 'alpr',
      px: 14,
      variants: [
        v('device', 'DEVICE'),
        v('bracket', 'BRACKET', family('svb')),
        v('badge', 'BADGE', family('svs')),
      ],
    },
    { key: 'landmarks', glyph: 'frame', px: 12 },
    {
      key: 'cctv',
      glyph: 'bracket',
      px: 15,
      variants: [
        v('bracket', 'BRACKET'),
        v('camera', 'CAMERA', { bracket: 'cam-fixed' }),
        v('dome', 'DOME', { bracket: 'cam-dome' }),
      ],
    },
    {
      key: 'trafficcams',
      glyph: 'bracket',
      px: 12,
      variants: [
        v('bracket', 'BRACKET'),
        v('road', 'ROAD', { bracket: 'wc-traffic' }),
        v('camera', 'CAMERA', { bracket: 'cam-fixed' }),
      ],
    },
    { key: 'webcams', glyph: 'wc-mountain', px: 14 },
    { key: 'datacenters', glyph: 'frame', px: 11 },
    { key: 'dams', glyph: 'triangle', px: 11 },
    { key: 'installations', glyph: 'diamond', px: 12 },
    { key: 'radio', glyph: 'cross', px: 10 },
    { key: 'shodan', glyph: 'frame', px: 10 },
    { key: 'bgp', glyph: 'dot', px: 8 },
    { key: 'tor', glyph: 'exit', px: 12 },
    { key: 'gdelt', glyph: 'news', px: 12 },
    { key: 'myplaces', glyph: 'diamond', px: 13 },
  ].map((l) => Object.freeze(l)),
);

const BY_KEY = new Map(ICON_LAYERS.map((l) => [l.key, l]));

/** The registry entry of a layer key, or null. */
export const iconLayer = (key) => BY_KEY.get(key) ?? null;

/** The default variant id of a layer, or null when it has none. */
export const defaultVariant = (key) => iconLayer(key)?.variants?.[0]?.id ?? null;

/** A layer's variant by id (its default when unknown), or null without variants. */
export function variantOf(key, id) {
  const list = iconLayer(key)?.variants;
  if (!list) return null;
  return list.find((x) => x.id === id) ?? list[0];
}

/** The glyph name a variant draws for one of the layer's own glyph names. */
export const variantGlyph = (variant, name) => variant?.glyphs[name] ?? name;

// --- settings keys ------------------------------------------------------------

export const sizeKey = (layer) => `iconSize.${layer}`;
export const variantKey = (layer) => `iconVariant.${layer}`;

/**
 * The icon settings for core/settings/store.js, in the store's own shape (a
 * default and the allowed values), so validation, reset, export and import
 * cover them like any other setting.
 */
export const ICON_SETTINGS_SCHEMA = Object.freeze(
  Object.fromEntries([
    ['iconScaling', { def: 'zoom', values: [...ICON_SCALING] }],
    ['iconSize', { def: 100, values: [...ICON_SIZES] }],
    ...ICON_LAYERS.flatMap((l) => [
      [sizeKey(l.key), { def: 100, values: [...LAYER_SIZES] }],
      ...(l.variants
        ? [
            [
              variantKey(l.key),
              { def: l.variants[0].id, values: l.variants.map((x) => x.id) },
            ],
          ]
        : []),
    ]),
  ]),
);

/** Whether a settings key is one of the icon settings. */
export const isIconKey = (key) => Object.hasOwn(ICON_SETTINGS_SCHEMA, key);

// --- size math ----------------------------------------------------------------

/**
 * The value of a distance curve { near, nearValue, far, farValue } (a Cesium
 * NearFarScalar has that shape) at a distance in metres, exactly as Cesium's
 * shader evaluates it (czm_nearFarScalar): clamped outside [near, far],
 * t = ((d^2 - near^2) / (far^2 - near^2))^0.2 in between. No curve: 1.
 */
export function curveAt(curve, d) {
  if (!curve) return 1;
  const n2 = curve.near * curve.near;
  const f2 = curve.far * curve.far;
  let t = f2 > n2 ? (d * d - n2) / (f2 - n2) : 1;
  t = t <= 0 ? 0 : t >= 1 ? 1 : t ** 0.2;
  return curve.nearValue + (curve.farValue - curve.nearValue) * t;
}

/** The close-up curve built on a layer's own curve (see ZOOM). */
export function zoomCurve(base) {
  return {
    near: ZOOM.nearM,
    nearValue: ZOOM.max * curveAt(base, ZOOM.nearM),
    far: ZOOM.farM,
    farValue: curveAt(base, ZOOM.farM),
  };
}

/** Whether the close-up curve applies at a camera height (with hysteresis). */
export const closeRegime = (heightM, wasClose) =>
  wasClose ? heightM < ZOOM.leaveM : heightM < ZOOM.enterM;

/**
 * Canvas density for a glyph shown up to maxPx CSS px across: 2 (the usual,
 * crisp at map sizes), 3 or 4 for icons that grow, so a close-up icon is
 * drawn from enough pixels rather than magnified (and a small one is not
 * shrunk from far too many: billboard textures have no mipmaps). Three
 * cached copies at most.
 */
export const glyphDensity = (maxPx) => (maxPx <= 20 ? 2 : maxPx <= 48 ? 3 : 4);

const SIZE_STEP = new Map(LAYER_SIZES.map((s, i) => [s, i]));

/** The next per-layer size up (dir 1) or down (-1), clamped to LAYER_SIZES. */
export function stepSize(current, dir) {
  const i = SIZE_STEP.get(current) ?? SIZE_STEP.get(100);
  return LAYER_SIZES[Math.max(0, Math.min(LAYER_SIZES.length - 1, i + dir))];
}

/**
 * How one layer draws its icons now: size (the multiplier on its pixel
 * sizes), curve (the distance curve its billboards take), maxScale (the
 * largest on-screen factor size and curves can reach, for glyph density;
 * the same in both regimes, so the curve swap never swaps images, which
 * would load new atlas entries and blink), variant (or null) and
 * glyphName(name).
 * @param {{ scaling: string, size: number, sizes: object, variants: object, close: boolean }} prefs
 * @param {string} key the layer key
 * @param {{ near: number, nearValue: number, far: number, farValue: number }|null} base
 *   the layer's own curve
 */
export function iconLook(prefs, key, base) {
  const size = ((prefs.size ?? 100) / 100) * ((prefs.sizes?.[key] ?? 100) / 100);
  const zoom = prefs.scaling !== 'fixed';
  const close = zoom ? zoomCurve(base) : null;
  const curve = zoom && prefs.close ? close : base;
  const top = Math.max(
    base ? Math.max(base.nearValue, base.farValue) : 1,
    close ? close.nearValue : 0,
  );
  const variant = variantOf(key, prefs.variants?.[key]);
  return {
    size,
    curve,
    maxScale: size * top,
    variant,
    glyphName: (name) => variantGlyph(variant, name),
  };
}

// --- the shared policy ----------------------------------------------------------

/** Read the icon prefs out of a full settings object. */
export function prefsFromSettings(all) {
  const sizes = {};
  const variants = {};
  for (const l of ICON_LAYERS) {
    sizes[l.key] = all?.[sizeKey(l.key)] ?? 100;
    if (l.variants) variants[l.key] = all?.[variantKey(l.key)] ?? l.variants[0].id;
  }
  return {
    scaling: all?.iconScaling ?? 'zoom',
    size: all?.iconSize ?? 100,
    sizes,
    variants,
  };
}

/**
 * The icon state shared by every layer of one scene: the prefs, whether the
 * camera is in the close-up regime, and a version that changes whenever any
 * layer must restyle (a setting, or the regime while scaling with zoom).
 * Layers compare the version once per frame and restyle only on a change.
 */
export function createIconPolicy(onChange) {
  const state = {
    scaling: 'zoom',
    size: 100,
    sizes: {},
    variants: {},
    close: false,
    version: 0,
  };
  let sig = '';
  const bump = () => {
    state.version += 1;
    onChange?.();
  };
  return {
    get version() {
      return state.version;
    },
    get close() {
      return state.close;
    },
    get scaling() {
      return state.scaling;
    },
    /** The current prefs (read only). */
    get prefs() {
      return state;
    },
    /** Apply a full settings object; true when anything changed. */
    apply(all) {
      const p = prefsFromSettings(all);
      const next = JSON.stringify(p);
      if (next === sig) return false;
      sig = next;
      Object.assign(state, p);
      bump();
      return true;
    },
    /** The camera's height this frame: may switch the regime. */
    observe(heightM) {
      if (!Number.isFinite(heightM)) return false;
      const close = closeRegime(heightM, state.close);
      if (close === state.close) return false;
      state.close = close;
      if (state.scaling === 'zoom') bump();
      return true;
    },
    /** How one layer draws now (iconLook). */
    look: (key, base) => iconLook(state, key, base),
  };
}

const policies = new WeakMap();

/**
 * The icon policy of a scene (one per Cesium scene, made on first use). It
 * watches the camera height once per frame (one property read) and asks for
 * a frame when the layers must restyle.
 */
export function iconPolicy(scene) {
  let p = policies.get(scene);
  if (!p) {
    p = createIconPolicy(() => scene?.requestRender?.());
    policies.set(scene, p);
    scene?.preRender?.addEventListener?.(() => {
      p.observe(scene.camera?.positionCartographic?.height);
    });
  }
  return p;
}

/** Keep a policy in step with the settings store; returns the unsubscribe. */
export function bindIconSettings(policy, settings) {
  policy.apply(settings.all());
  return settings.subscribe((key, _value, all) => {
    if (isIconKey(key)) policy.apply(all);
  });
}
