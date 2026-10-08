import * as Cesium from 'cesium';

// Batched ground decorations for a point layer: every filled shape of the
// layer in ONE GroundPrimitive and every outline in ONE GroundPolylinePrimitive,
// rebuilt only when the layer's record set changes (debounced) or the zoom band
// changes, never per frame. Used for the surveillance view cones and the
// traffic-incident road lines.
//
// Ground primitives, not a plain Primitive at ellipsoid height: the globe has
// real relief and depthTestAgainstTerrain is on (core/scene/createViewer.js),
// so geometry at height 0 would sit buried under any city above sea level.
// Ground primitives drape onto terrain and photoreal tiles alike. Geometry is
// tessellated in Cesium's workers (asynchronous); the new primitives load while
// the old ones stay on screen, and replace them once ready, so a rebuild never
// flickers. Neither primitive is pickable: taps go to the layer's glyphs.
//
// The per-frame cost is one height comparison (the zoom band) while shown.

/**
 * @typedef {{ ring: number[], color: import('cesium').Color }} GroundFill
 *   ring: flat open [lon, lat, ...] degrees
 * @typedef {{ path: number[], color: import('cesium').Color, width?: number,
 *   loop?: boolean }} GroundLine   path: flat [lon, lat, ...] degrees
 * @typedef {{ scale: number, center: { lon: number, lat: number } }} CollectCtx
 */

let warned = false;

/**
 * @param {import('cesium').Scene} scene
 * @param {{ collect: (ctx: CollectCtx) => { fills: GroundFill[], lines: GroundLine[] },
 *   scaleFor?: (heightM: number) => number, debounceMs?: number }} opts
 *   scaleFor returns a size factor for the camera height (0 hides the batch);
 *   a change of factor rebuilds the geometry once the camera settles.
 */
export function createGroundBatch(
  scene,
  { collect, scaleFor = () => 1, debounceMs = 300 },
) {
  // Ground primitives drape on terrain but are not on every GPU or Cesium
  // build; if the check is missing or throws, degrade to no cones (the layer's
  // points still show) rather than failing to start.
  let supported = false;
  try {
    supported =
      Cesium.GroundPrimitive?.isSupported?.(scene) === true &&
      Cesium.GroundPolylinePrimitive?.isSupported?.(scene) === true;
  } catch {
    supported = false;
  }
  if (!supported && !warned) {
    warned = true;
    console.warn('[argus] ground primitives unsupported here: view cones are off');
  }
  let fillPrim = null;
  let linePrim = null;
  let pending = null; // { fill, line, started, poll }
  let visible = true;
  let destroyed = false;
  // When ground primitives are unsupported nothing is ever built, so stay
  // "clean": the preRender guard then short-circuits every frame (one boolean)
  // instead of re-checking the zoom band and rescheduling a build that returns.
  let dirty = supported;
  let timer = null;
  const heightNow = () => scene.camera.positionCartographic.height;
  let scale = scaleFor(heightNow());
  let builtScale = -1;

  const drop = (p) => {
    if (p && !p.isDestroyed?.() && scene.primitives.contains(p))
      scene.primitives.remove(p);
  };

  function applyShow() {
    const on = visible && scale > 0;
    if (fillPrim) fillPrim.show = on;
    if (linePrim) linePrim.show = on;
  }

  function discardPending() {
    if (!pending) return;
    clearInterval(pending.poll);
    drop(pending.fill);
    drop(pending.line);
    pending = null;
  }

  function swapIn(fill, line) {
    drop(fillPrim);
    drop(linePrim);
    fillPrim = fill;
    linePrim = line;
    applyShow();
    scene.requestRender();
  }

  function checkPending() {
    const p = pending;
    if (!p) return;
    const ready = (!p.fill || p.fill.ready) && (!p.line || p.line.ready);
    // Workers progress only on rendered frames (requestRenderMode): ask for one.
    if (!ready && performance.now() - p.started < 20_000) {
      scene.requestRender();
      return;
    }
    clearInterval(p.poll);
    pending = null;
    swapIn(p.fill, p.line);
  }

  function center() {
    const c = scene.camera.positionCartographic;
    return { lon: (c.longitude * 180) / Math.PI, lat: (c.latitude * 180) / Math.PI };
  }

  function build() {
    timer = null;
    if (destroyed || !supported) return;
    // Hidden (layer off, or zoomed out past the ceiling): build when shown.
    if (!visible || scale === 0) return;
    dirty = false;
    builtScale = scale;
    discardPending();
    const { fills = [], lines = [] } = collect({ scale, center: center() }) || {};
    const fill = fills.length
      ? scene.primitives.add(
          new Cesium.GroundPrimitive({
            geometryInstances: fills.map(
              (f) =>
                new Cesium.GeometryInstance({
                  geometry: new Cesium.PolygonGeometry({
                    polygonHierarchy: new Cesium.PolygonHierarchy(
                      Cesium.Cartesian3.fromDegreesArray(f.ring),
                    ),
                  }),
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(f.color),
                  },
                }),
            ),
            appearance: new Cesium.PerInstanceColorAppearance({
              flat: true,
              translucent: true,
            }),
            classificationType: Cesium.ClassificationType.BOTH,
            asynchronous: true,
            allowPicking: false,
            releaseGeometryInstances: true,
          }),
        )
      : null;
    const line = lines.length
      ? scene.primitives.add(
          new Cesium.GroundPolylinePrimitive({
            geometryInstances: lines.map(
              (l) =>
                new Cesium.GeometryInstance({
                  geometry: new Cesium.GroundPolylineGeometry({
                    positions: Cesium.Cartesian3.fromDegreesArray(l.path),
                    width: l.width ?? 1.5,
                    loop: Boolean(l.loop),
                  }),
                  attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(l.color),
                  },
                }),
            ),
            appearance: new Cesium.PolylineColorAppearance(),
            classificationType: Cesium.ClassificationType.BOTH,
            asynchronous: true,
            allowPicking: false,
            releaseGeometryInstances: true,
          }),
        )
      : null;
    if (!fill && !line) {
      swapIn(null, null);
      return;
    }
    pending = { fill, line, started: performance.now(), poll: null };
    pending.poll = setInterval(checkPending, 150);
    scene.requestRender();
  }

  function schedule() {
    if (destroyed || !supported) return;
    clearTimeout(timer);
    timer = setTimeout(build, debounceMs);
  }

  // The zoom band: one comparison per rendered frame, a rebuild only when the
  // band changes (and the camera has settled, through the debounce).
  const removePreRender = scene.preRender.addEventListener(() => {
    if (!visible || (!fillPrim && !linePrim && !pending && !dirty)) return;
    const s = scaleFor(heightNow());
    if (s === scale) return;
    scale = s;
    applyShow();
    if (s > 0 && (dirty || s !== builtScale)) schedule();
  });

  return {
    /** The decorated record set changed: rebuild once things settle. */
    markDirty() {
      if (!supported) return;
      dirty = true;
      schedule();
    },
    setVisible(on) {
      visible = Boolean(on);
      applyShow();
      if (visible && (dirty || scale !== builtScale)) schedule();
      else if (!visible) discardPending();
      scene.requestRender();
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      discardPending();
      removePreRender();
      swapIn(null, null);
    },
  };
}

/**
 * Definition hooks (onEntityCreate / onShow) that keep one ground batch per
 * scene for a layer: each record joins the batch when created and leaves it
 * when removed; `collect(records, ctx)` turns the current records into shapes.
 * @param {{ collect: (records: Map<string, object>, ctx: CollectCtx) =>
 *   { fills: GroundFill[], lines: GroundLine[] }, scaleFor?: (h: number) => number }} opts
 */
export function groundDecorations({ collect, scaleFor }) {
  const perScene = new WeakMap(); // scene -> { records, batch }
  const stateFor = (scene) => {
    let st = perScene.get(scene);
    if (!st) {
      const records = new Map();
      st = {
        records,
        batch: createGroundBatch(scene, {
          scaleFor,
          collect: (ctx) => collect(records, ctx),
        }),
      };
      perScene.set(scene, st);
    }
    return st;
  };
  return {
    onEntityCreate(target, normalized, { scene }) {
      const st = stateFor(scene);
      st.records.set(target.id, normalized);
      st.batch.markDirty();
      return () => {
        st.records.delete(target.id);
        st.batch.markDirty();
      };
    },
    onShow(on, { scene }) {
      stateFor(scene).batch.setVisible(on);
    },
  };
}
