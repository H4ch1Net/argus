import * as Cesium from 'cesium';
import { classifyAircraft } from '../layers/flights/aircraftClass.js';

// 3D aircraft close to the camera. Below 800 km of camera height, the aircraft
// nearest the camera (within 150 km, kept until 185 km so they do not flicker
// at the edge) swap their silhouette for a glTF model of their class: a 787 for
// widebodies, an ATR 72 for turboprops, a Bell 206 for helicopters, a Cessna
// 172, a Citation, an MQ-9, a 747 for other airliners, a jet for fast movers.
// Models are tinted ctOS white (gray on the ground) and keep the contact's id,
// so a click on a model selects it like the glyph would.
//
// Budgets per tier (each model is its own draw call): full 60, balanced 12,
// minimal none. The set is re-chosen twice a second and on every camera stop;
// model matrices update each frame from the same interpolated positions the
// glyphs use. The GLBs are CC BY 4.0 (credits in public/models/README.md).
// Distances, caps and the heading offset follow gods-eye-view's flights
// policy (MIT), where these models were prepared.

const ALT_CEIL_M = 800_000;
const ADD_M = 150_000;
const KEEP_M = 185_000;
const HEADING_OFFSET_DEG = 180; // the GLBs face local -X
const MIN_PX = 24;
const BLEND = 0.94;
const PICK_MS = 500;
const CAP = { full: 60, balanced: 12, minimal: 0 };
const AIRCRAFT_LAYERS = new Set(['flights', 'military', 'localadsb']);

const REAL = {
  helicopter: '/models/bell206.glb',
  light: '/models/c172.glb',
  bizjet: '/models/citation2.glb',
  uav: '/models/mq9.glb',
  widebody: '/models/b789.glb',
  turboprop: '/models/atr72.glb',
};
const SHARED_SCALE = { airliner: 1, quadjet: 1.45, glider: 0.75, fastjet: 0.8 };

/** The model a contact of this layer and class renders with. */
export function modelSpecFor(layerKey, kind) {
  if (REAL[kind]) return { url: REAL[kind], scale: 1 };
  const url =
    layerKey === 'military' && kind !== 'airliner' && kind !== 'quadjet'
      ? '/models/jet.glb'
      : '/models/airplane.glb';
  return { url, scale: SHARED_SCALE[kind] ?? 1 };
}

const WHITE = Cesium.Color.fromCssColorString('#ffffff');
const GROUND = Cesium.Color.fromCssColorString('#7a7a7a');
const MINT = Cesium.Color.fromCssColorString('#a6ffc9');

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ getLayers: () => { key: string, layer: object }[], tier: string }} opts
 */
export function createModelLod(viewer, { getLayers, tier }) {
  const scene = viewer.scene;
  const cap = CAP[tier] ?? 0;
  const collection = scene.primitives.add(new Cesium.PrimitiveCollection());
  const live = new Map(); // target -> { model|null, layer, key, n, loading, epoch }
  let enabled = cap > 0;
  let lastPick = 0;
  let epoch = 0;
  const hpr = new Cesium.HeadingPitchRoll();
  const pos = new Cesium.Cartesian3();

  function release(target) {
    const e = live.get(target);
    if (!e) return;
    live.delete(target);
    if (e.model && !e.model.isDestroyed()) collection.remove(e.model);
    e.layer.suppress?.(target.id, false);
  }

  function releaseAll() {
    for (const t of [...live.keys()]) release(t);
  }

  async function load(target, e) {
    const kind = classifyAircraft(e.n.meta);
    const spec = modelSpecFor(e.key, kind);
    const myEpoch = epoch;
    try {
      const model = await Cesium.Model.fromGltfAsync({
        url: spec.url,
        scale: spec.scale,
        minimumPixelSize: MIN_PX,
        color: e.n.meta?.onGround ? GROUND : e.key === 'military' ? MINT : WHITE,
        colorBlendMode: Cesium.ColorBlendMode.MIX,
        colorBlendAmount: BLEND,
        id: target,
      });
      // Released, re-chosen or switched off while loading: drop it.
      if (live.get(target) !== e || myEpoch !== epoch) {
        model.destroy();
        return;
      }
      e.model = model;
      place(target, e);
      collection.add(model);
      // Hide the glyph only once the model is in place (never neither).
      e.layer.suppress?.(target.id, true);
      scene.requestRender();
    } catch {
      release(target);
    }
  }

  function place(target, e) {
    if (!e.model) return;
    const p = target.position.getValue(viewer.clock.currentTime, pos);
    if (!p) return;
    const course = e.n.meta?.trueTrack ?? e.n.velocity?.heading ?? 0;
    hpr.heading = Cesium.Math.toRadians(course + HEADING_OFFSET_DEG);
    hpr.pitch = 0;
    hpr.roll = 0;
    // Each model writes into its own matrix (a shared scratch would stack them).
    Cesium.Transforms.headingPitchRollToFixedFrame(
      p,
      hpr,
      Cesium.Ellipsoid.WGS84,
      undefined,
      e.model.modelMatrix,
    );
  }

  function pick() {
    const camH = scene.camera.positionCartographic.height;
    if (!enabled || camH > ALT_CEIL_M) {
      releaseAll();
      return;
    }
    const cam = scene.camera.positionWC;
    const cand = [];
    for (const { key, layer } of getLayers()) {
      if (!AIRCRAFT_LAYERS.has(key) || !layer.forEachVisible) continue;
      layer.forEachVisible((target, world, n) => {
        const d = Cesium.Cartesian3.distance(cam, world);
        const limit = live.has(target) ? KEEP_M : ADD_M;
        if (d <= limit) cand.push({ target, key, layer, n, d });
      });
    }
    cand.sort((a, b) => a.d - b.d);
    const keep = new Set();
    for (const c of cand.slice(0, cap)) {
      keep.add(c.target);
      const e = live.get(c.target);
      if (e) {
        e.n = c.n;
        continue;
      }
      const entry = { model: null, layer: c.layer, key: c.key, n: c.n };
      live.set(c.target, entry);
      load(c.target, entry);
    }
    for (const t of [...live.keys()]) if (!keep.has(t)) release(t);
  }

  const removePre = scene.preRender.addEventListener(() => {
    const now = performance.now();
    if (now - lastPick > PICK_MS) {
      lastPick = now;
      pick();
    }
    for (const [t, e] of live) place(t, e);
  });
  const removeMove = scene.camera.moveEnd.addEventListener(() => {
    lastPick = 0;
  });

  return {
    get enabled() {
      return enabled;
    },
    supported: cap > 0,
    setEnabled(on) {
      enabled = Boolean(on) && cap > 0;
      epoch += 1;
      if (!enabled) releaseAll();
      lastPick = 0;
      scene.requestRender();
    },
    count: () => live.size,
    destroy() {
      removePre();
      removeMove();
      releaseAll();
      scene.primitives.remove(collection);
    },
  };
}
