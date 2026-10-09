import * as Cesium from 'cesium';
import {
  acquireContinuousRender,
  releaseContinuousRender,
} from '../../scene/renderMode.js';
import { createGroundBatch } from '../surveillance/groundBatch.js';
import { glyph } from '../../ui/glyphs.js';
import { iconPolicy, glyphDensity } from '../../ui/iconPrefs.js';
import { createSimulation } from './sim.js';
import { MAX_SIM_HEIGHT_M } from './roads.js';
import { CRAWL_MPS, VEHICLE_COLORS, roadLineStyle, simTrafficNote } from './format.js';
import { simTrafficView } from './view.js';

// Draws the simulated traffic (renderType 'field', see core/layers/sdk/fieldLayer.js):
//
//   vehicles  one BillboardCollection, a heading-up vehicle glyph per
//             simulated car (a car in plan view by default; size, variant and
//             scale-with-zoom from SETTINGS > ICONS, core/ui/iconPrefs.js,
//             applied to the pool once per change), positions written on a
//             fleet tick of 12 to 15 Hz
//             through the shared frame pacer (core/scene/renderMode.js), and
//             only while the layer is on, the page visible and the camera
//             below 8 km. The pool of billboards is made once per slot; a
//             tick allocates nothing.
//   roads     every congested road as ONE batched ground polyline primitive
//             (core/layers/surveillance/groundBatch.js), rebuilt only when the
//             congestion or the network changes, hidden above 8 km.
//
// The model (source.js) is the "field": the renderer watches its version
// counters, rebuilds the simulation's network when the roads change, and
// re-points the model at the view once a second when the camera has moved.

/** Fleet caps by capability tier (the car runs the minimal tier). */
export const FLEET_CAP = { minimal: 150, balanced: 400, full: 1500 };
const TICK_FPS = { minimal: 12, balanced: 12, full: 15 };
const VEHICLE_PX = 11; // nominal glyph size, CSS px, before the icon settings
const LIFT_M = 1.5; // above the sampled ground, so glyphs never sink into it
const HEIGHT_CHUNK = 2500; // terrain height samples per frame

/**
 * @param {import('cesium').Viewer} viewer
 * @param {{ onStatus?: Function }} ctx
 * @param {{ tier?: string }} [opts]
 */
export function createSimTrafficRenderer(viewer, ctx = {}, { tier = 'balanced' } = {}) {
  const scene = viewer.scene;
  const cap = FLEET_CAP[tier] ?? FLEET_CAP.balanced;
  const fps = TICK_FPS[tier] ?? 12;
  const tickMs = 1000 / fps - 4;
  const sim = createSimulation({ cap });
  const collection = scene.primitives.add(new Cesium.BillboardCollection());
  collection.show = false;
  // The fleet's own distance curve (FIXED icons): full size up close, under
  // half at the 8 km ceiling. Scaling with zoom builds the close-up curve on it.
  const ownCurve = new Cesium.NearFarScalar(400, 1.0, MAX_SIM_HEIGHT_M, 0.45);
  const icons = iconPolicy(scene);
  const look = { g: null, scale: 1, scalar: ownCurve, version: -1 };
  /** Read the icon settings into look; true when the pool must restyle. */
  function readLook() {
    if (look.version === icons.version) return false;
    look.version = icons.version;
    const l = icons.look('simtraffic', ownCurve);
    look.g = glyph(l.glyphName('vehicle'), glyphDensity(VEHICLE_PX * l.maxScale));
    look.scale = (VEHICLE_PX * l.size) / look.g.px;
    const c = l.curve;
    const s = look.scalar;
    if (
      s.near !== c.near ||
      s.nearValue !== c.nearValue ||
      s.far !== c.far ||
      s.farValue !== c.farValue
    ) {
      look.scalar =
        c === ownCurve
          ? ownCurve
          : new Cesium.NearFarScalar(c.near, c.nearValue, c.far, c.farValue);
    }
    return true;
  }
  readLook();
  /** Apply the look to one pooled billboard (no-ops when nothing changed). */
  function styleSlot(b) {
    if (b._argusGlyph !== look.g.id) {
      b.setImage(look.g.id, look.g.image);
      b._argusGlyph = look.g.id;
    }
    if (b.scale !== look.scale) b.scale = look.scale;
    if (b._argusCurve !== look.scalar) {
      b.scaleByDistance = look.scalar;
      b._argusCurve = look.scalar;
    }
  }
  const colors = {
    moving: Cesium.Color.fromCssColorString(VEHICLE_COLORS.moving).withAlpha(0.95),
    crawling: Cesium.Color.fromCssColorString(VEHICLE_COLORS.crawling).withAlpha(0.95),
  };
  const pool = []; // billboards by slot
  const where = []; // each slot's own position object (made once per slot)
  const state = new Uint8Array(cap); // colour per slot: 0 unset, 1 moving, 2 crawling
  // Heading-up glyphs align "up" with local north (one vector for the whole
  // network: a few kilometres change it by a hundredth of a degree).
  const north = new Cesium.Cartesian3(0, 0, 1);
  function setNorth(lat, lon) {
    const la = Cesium.Math.toRadians(lat);
    const lo = Cesium.Math.toRadians(lon);
    north.x = -Math.sin(la) * Math.cos(lo);
    north.y = -Math.sin(la) * Math.sin(lo);
    north.z = Math.cos(la);
    for (const b of pool) b.alignedAxis = north;
  }
  let shown = 0;

  let model = null;
  let visible = false;
  let low = false;
  let claimed = 0;
  let lastStep = 0;
  let lastView = 0;
  let lastStatus = 0;
  let lastNote = '';
  const seen = { version: -1, flowVersion: -1, focusVersion: -1 };
  const cost = { frames: 0, ms: 0, maxMs: 0 }; // fleet tick cost, for the harness
  let heightJob = null; // { edges, i, k } terrain sampling in chunks

  // --- roads ---------------------------------------------------------------------

  const lineColor = new Map();
  const colorOf = (css, alpha) => {
    const key = `${css}|${alpha}`;
    let c = lineColor.get(key);
    if (!c) {
      c = Cesium.Color.fromCssColorString(css).withAlpha(alpha);
      lineColor.set(key, c);
    }
    return c;
  };
  const batch = createGroundBatch(scene, {
    scaleFor: (h) => (h < MAX_SIM_HEIGHT_M ? 1 : 0),
    collect: () => {
      const lines = [];
      const net = model?.network;
      if (!net || !model.active) return { fills: [], lines };
      // Consecutive pieces of one way with the same style join into one line.
      let run = null;
      const flush = () => {
        if (run && run.path.length >= 4) lines.push(run);
        run = null;
      };
      let prevWay = null;
      for (const e of net.edges) {
        const st = roadLineStyle(e, model.flow.get(e.id));
        const key = st ? `${st.color}|${st.alpha}|${st.width}` : null;
        if (!st || e.wayId !== prevWay || run?.key !== key) flush();
        prevWay = e.wayId;
        if (!st) continue;
        const flat = Array.from(e.coords);
        if (run) run.path.push(...flat.slice(2));
        else
          run = { key, path: flat, color: colorOf(st.color, st.alpha), width: st.width };
      }
      flush();
      return { fills: [], lines };
    },
  });

  // --- terrain heights --------------------------------------------------------------

  function startHeights() {
    const net = model?.network;
    heightJob = null;
    if (!net) return;
    const flat =
      !scene.terrainProvider ||
      scene.terrainProvider instanceof Cesium.EllipsoidTerrainProvider;
    if (flat || typeof scene.globe?.getHeight !== 'function') return;
    heightJob = { edges: net.edges, i: 0, k: 0, passes: 0 };
  }
  const carto = new Cesium.Cartographic();
  function stepHeights() {
    const job = heightJob;
    if (!job) return;
    let budget = HEIGHT_CHUNK;
    while (budget > 0 && job.i < job.edges.length) {
      const e = job.edges[job.i];
      const nv = e.cum.length;
      if (!e.heights) e.heights = new Float32Array(nv);
      while (job.k < nv && budget > 0) {
        carto.longitude = Cesium.Math.toRadians(e.coords[job.k * 2]);
        carto.latitude = Cesium.Math.toRadians(e.coords[job.k * 2 + 1]);
        carto.height = 0;
        const hgt = scene.globe.getHeight(carto);
        if (Number.isFinite(hgt)) e.heights[job.k] = hgt;
        job.k += 1;
        budget -= 1;
      }
      if (job.k >= nv) {
        job.i += 1;
        job.k = 0;
      }
    }
    if (job.i >= job.edges.length) {
      // A second pass a few seconds later, once finer terrain has loaded.
      job.passes += 1;
      if (job.passes < 2) {
        job.i = 0;
        job.k = 0;
        job.wait = performance.now() + 4000;
      } else heightJob = null;
    }
  }

  // --- the fleet ---------------------------------------------------------------------

  function slot(i) {
    let b = pool[i];
    if (!b) {
      b = collection.add({
        position: Cesium.Cartesian3.ZERO,
        show: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        alignedAxis: north,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      });
      styleSlot(b);
      pool[i] = b;
      where[i] = new Cesium.Cartesian3();
    }
    return b;
  }

  function writeFleet() {
    const n = sim.computePositions();
    for (let i = 0; i < n; i += 1) {
      const b = slot(i);
      b.position = Cesium.Cartesian3.fromDegrees(
        sim.lon[i],
        sim.lat[i],
        sim.height[i] + LIFT_M,
        Cesium.Ellipsoid.WGS84,
        where[i],
      );
      b.rotation = -sim.heading[i];
      const st = sim.speed[i] < CRAWL_MPS ? 2 : 1;
      if (state[i] !== st) {
        state[i] = st;
        b.color = st === 2 ? colors.crawling : colors.moving;
      }
      if (!b.show) b.show = true;
    }
    for (let i = n; i < shown; i += 1) pool[i].show = false;
    shown = n;
    return n;
  }

  function hideFleet() {
    for (let i = 0; i < shown; i += 1) pool[i].show = false;
    shown = 0;
  }

  // --- pacing ------------------------------------------------------------------------

  function pace(on) {
    const rate = on ? fps : 0;
    if (rate === claimed) return;
    if (claimed) releaseContinuousRender(scene, claimed);
    claimed = rate;
    if (rate) acquireContinuousRender(scene, rate);
  }

  function report(force = false) {
    const t = performance.now();
    if (!force && t - lastStatus < 2000) return;
    lastStatus = t;
    if (model) model.vehicles = low ? sim.count : 0;
    const note = simTrafficNote(model, low ? sim.count : 0);
    if (!force && note === lastNote) return;
    lastNote = note;
    ctx.onStatus?.({
      state: model?.error && !model?.network?.edges.length ? 'error' : 'ok',
      count: low ? sim.count : 0,
      note,
      message: model?.error || undefined,
    });
  }

  // Watch the model: rebuild the simulation when the roads change, push new
  // congestion, follow the view's focus.
  function sync() {
    if (!model) return;
    if (seen.version !== model.version) {
      seen.version = model.version;
      seen.focusVersion = model.focusVersion;
      seen.flowVersion = -1;
      if (model.network && model.active) {
        sim.setNetwork(model.network, {
          focus: model.focus,
          radiusM: model.radiusM,
          leftHand: model.leftHand,
          seed: model.seed,
        });
        setNorth(model.network.origin.lat, model.network.origin.lon);
        startHeights();
      }
      batch.markDirty();
      report(true);
    }
    if (seen.flowVersion !== model.flowVersion) {
      seen.flowVersion = model.flowVersion;
      sim.setFlow((e) => model.flow.get(e.id));
      batch.markDirty();
      report(true);
    }
    if (seen.focusVersion !== model.focusVersion) {
      seen.focusVersion = model.focusVersion;
      sim.setFocus(model.focus, model.radiusM);
    }
  }

  /** Tick cost so far (harness and the dev console). */
  function stats() {
    return {
      vehicles: sim.count,
      ticks: cost.frames,
      avgMs: cost.frames ? cost.ms / cost.frames : 0,
      maxMs: cost.maxMs,
      fps,
      cap,
    };
  }

  function onPreRender() {
    if (!visible || !model) return;
    const t = performance.now();
    const h = scene.camera.positionCartographic.height;
    const isLow = model.active && h < MAX_SIM_HEIGHT_M;
    // Re-point the model at the view about once a second (a drive in the car
    // view moves the focus without the camera ever settling).
    if (t - lastView > 1000) {
      lastView = t;
      const v = simTrafficView(viewer);
      const far =
        !model.focus ||
        model.active !== v.heightM < MAX_SIM_HEIGHT_M ||
        Math.hypot(
          (v.lat - model.focus.lat) * 110_540,
          (v.lon - model.focus.lon) * 111_320 * Math.cos((v.lat * Math.PI) / 180),
        ) >
          model.radiusM / 4 ||
        Math.abs(v.heightM - (model.view?.heightM ?? v.heightM)) > 400;
      if (far) model.update(v);
    }
    if (isLow !== low) {
      low = isLow;
      collection.show = low;
      if (!low) hideFleet();
      report(true);
    }
    pace(low && sim.count > 0 && !document.hidden);
    if (!low) return;
    // SETTINGS > ICONS changed (or the zoom regime): restyle the pool once.
    if (readLook()) for (const b of pool) styleSlot(b);
    sync();
    if (heightJob && !(heightJob.wait > t)) stepHeights();
    if (t - lastStep < tickMs) return;
    const dt = lastStep ? (t - lastStep) / 1000 : 0;
    lastStep = t;
    sim.step(dt);
    writeFleet();
    const spent = performance.now() - t;
    cost.frames += 1;
    cost.ms += spent;
    if (spent > cost.maxMs) cost.maxMs = spent;
    report();
  }
  const removePreRender = scene.preRender.addEventListener(onPreRender);
  // Simulated vehicles are not contacts and never take a tap, but a billboard
  // without an id still fills a slot of the picker's drill pick (8 deep), so a
  // queue of cars could hide a real contact under the finger. Hide the fleet
  // for the one task in which the tap is picked (window capture runs before
  // the canvas handler), then show it again before the next frame.
  const onTapCapture = () => {
    if (!collection.show) return;
    collection.show = false;
    setTimeout(() => {
      collection.show = visible && low;
    }, 0);
  };
  window.addEventListener('pointerup', onTapCapture, true);
  const onVisibility = () => {
    if (document.hidden) pace(false);
    else {
      lastStep = 0; // no catch-up burst after a pause
      scene.requestRender();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    setField(m) {
      model = m;
      // Roads and flow arrive in the background: draw the next frame for them.
      if (model) {
        model.onChange = () => scene.requestRender();
        model.renderStats = stats; // the tick cost, for the dev console
      }
      scene.requestRender();
    },
    setVisible(on) {
      visible = Boolean(on);
      collection.show = visible && low;
      batch.setVisible(visible);
      if (!visible) {
        pace(false);
        hideFleet();
        model?.cancel?.();
        low = false;
        lastStep = 0;
      } else {
        lastView = 0;
      }
      scene.requestRender();
    },
    destroy() {
      pace(false);
      removePreRender();
      window.removeEventListener('pointerup', onTapCapture, true);
      document.removeEventListener('visibilitychange', onVisibility);
      batch.destroy();
      if (!collection.isDestroyed?.()) scene.primitives.remove(collection);
    },
    stats,
    sim,
  };
}
