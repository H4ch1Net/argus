import * as Cesium from 'cesium';
import { createRingBuffer } from './ringBuffer.js';
import { interpolateInto } from './interpolate.js';
import { computeViewportQuery, viewportShift } from './viewport.js';
import { getRenderer, isPrimitiveRenderType } from './renderers.js';
import { createRasterLayer } from './rasterLayer.js';
import { createFieldLayer } from './fieldLayer.js';
import {
  acquireContinuousRender,
  releaseContinuousRender,
} from '../../scene/renderMode.js';

// The Layer SDK engine. A layer is config against this interface, not bespoke
// code (CLAUDE.md): fetch -> normalize -> render -> interpolate?, with
// viewport-bounded fetch and load-only-in-view baked in.
//
// A LayerDefinition (static, reusable) provides:
//   id, fetch:{ mode, intervalMs, viewportBounded },
//   normalize(raw) -> NormalizedEntity[],
//   render:{ renderType, style(normalized)->styleProps, ...renderConfig },
//   interpolate?:boolean, historyCapacity?, interpolateLagMs?, maxEntities?,
//   positionAt?(normalized, timeMs), positionCacheMs?, animationFps?,
//   describe?(normalized) -> cardModel   (for the interaction spine)
//   statusNote?(query, raw) -> string     (a hint shown beside the count)
//   onEntityCreate?(target, normalized, { viewer, scene }) -> dispose
//   onShow?(shown, { viewer, scene })      (hide decorations with the layer)
//
// A NormalizedEntity is { id, position:{longitude,latitude,altitude}, type,
// meta, velocity? } per the contract.
//
// Performance model. Point and billboard layers (nearly all of them) draw into
// one BillboardCollection primitive per layer, never the Entity API: no property
// objects, no per-entity visualizer work, one draw call per glyph atlas. Movers
// are repositioned once per rendered frame in a single loop that reuses scratch
// objects, so thousands of interpolated aircraft allocate nothing per frame; the
// same loop hides what is behind the planet (a horizon test, cheaper than depth
// testing ground-level glyphs). Animation is paced by core/scene/renderMode.js
// (30 fps on a desktop, 20 on a phone), never continuous rendering.
//
// Each record exposes a `target`: a small object with an id and a Cesium-style
// `position.getValue(time, result)`. Picking, tracking, cockpit mode, search and
// the selection overlay all work from targets, so none of them needs an Entity.

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_HISTORY = 60;
const DEFAULT_MAX_ENTITIES = 2000;

/**
 * @param {import('cesium').Viewer} viewer
 * @param {object} def LayerDefinition
 * @param {{ source: Function, onStatus?: Function, clock?: object, animationFps?: number,
 *   groundClamp?: boolean }} ctx  groundClamp draws every record at ground level
 *   (its ground track): the car's camera sits below cruise altitude looking
 *   down, so aircraft drawn at altitude would never be in its view.
 */
export function createLayer(viewer, def, ctx) {
  if (typeof ctx?.source !== 'function') {
    throw new Error(`layer ${def.id}: a source function is required`);
  }
  // Field / overlay layers (weather) render as imagery, not entities.
  if (def.render?.renderType === 'raster') return createRasterLayer(viewer, def, ctx);
  if (def.render?.renderType === 'field') return createFieldLayer(viewer, def, ctx);
  const scene = viewer.scene;
  const intervalMs = def.fetch?.intervalMs ?? DEFAULT_INTERVAL_MS;
  // A layer is a mover if it interpolates between fixes OR computes its position
  // from time (def.positionAt, e.g. SGP4 satellites).
  const isMover = Boolean(def.interpolate || def.positionAt);
  const lagMs = isMover ? (def.interpolateLagMs ?? intervalMs) : 0;
  const historyCap = def.historyCapacity ?? DEFAULT_HISTORY;
  const maxEntities = def.maxEntities ?? DEFAULT_MAX_ENTITIES;
  const fps = def.animationFps ?? ctx.animationFps ?? 30;
  // 'poll' fetches the full set each interval (removal by absence); 'push'
  // receives incremental updates over a stream (removal by staleness).
  const mode = def.fetch?.mode ?? 'poll';
  const staleMs = def.staleMs ?? 120_000;
  // Scene time for positioning: the shared clock (so the time scrubber rewinds all
  // movers at once) or real time. Feed ingest/staleness always use real time.
  const sceneNow = () => (ctx.clock ? ctx.clock.now() : Date.now());
  const positionCacheMs = def.positionCacheMs ?? 0;

  const primitive = isPrimitiveRenderType(def.render.renderType);
  const renderer = getRenderer(def.render.renderType);
  // Billboard layers: one collection. Line layers (arcs, cables): one data source.
  const collection = primitive
    ? scene.primitives.add(new Cesium.BillboardCollection())
    : null;
  const ds = primitive ? null : new Cesium.CustomDataSource(def.id);
  if (ds) viewer.dataSources.add(ds);

  /** @type {Map<string, object>} */
  const records = new Map();
  let running = false;
  let shown = true;
  let timer = null;
  let aborter = null;
  let holdsRender = 0; // the frame rate claimed for movers, 0 for none
  let dirty = true; // positions or visibility must be recomputed next frame
  // Contacts drawn by something else for now (a 3D model close to the camera):
  // their glyph stays hidden while they keep counting as visible.
  const suppressed = new Set();

  // --- positions ------------------------------------------------------------

  const fix = { longitude: 0, latitude: 0, altitude: 0 };

  /** Geodetic position of a record now, into `fix`; false when unknown. */
  function geodeticNow(rec) {
    if (def.positionAt) {
      const t = sceneNow();
      if (positionCacheMs && rec.cached && Math.abs(t - rec.cached.t) < positionCacheMs) {
        fix.longitude = rec.cached.longitude;
        fix.latitude = rec.cached.latitude;
        fix.altitude = rec.cached.altitude;
        return true;
      }
      const p = def.positionAt(rec.normalized, t);
      if (!p) return false;
      fix.longitude = p.longitude;
      fix.latitude = p.latitude;
      fix.altitude = p.altitude ?? 0;
      if (positionCacheMs) {
        rec.cached = {
          t,
          longitude: p.longitude,
          latitude: p.latitude,
          altitude: fix.altitude,
        };
      }
      return true;
    }
    const curr = rec.history.last();
    if (!curr) return false;
    if (!def.interpolate) {
      fix.longitude = curr.longitude;
      fix.latitude = curr.latitude;
      fix.altitude = curr.altitude ?? 0;
    } else if (!ctx.clock || ctx.clock.isLive()) {
      interpolateInto(rec.history.prev(), curr, sceneNow() - lagMs, fix);
    } else {
      // Scrubbing: bracket the scrub time across the whole retained window.
      rec.history.sampleInto(sceneNow(), interpolateInto, fix);
    }
    return true;
  }

  /** World position of a record now (Cartesian3 into `result`), or undefined. */
  function positionOf(rec, result) {
    if (!geodeticNow(rec)) return undefined;
    return Cesium.Cartesian3.fromDegrees(
      fix.longitude,
      fix.latitude,
      ctx.groundClamp ? 0 : Math.max(0, fix.altitude),
      Cesium.Ellipsoid.WGS84,
      result ?? new Cesium.Cartesian3(),
    );
  }

  function makeTarget(id) {
    const target = {
      id,
      layerId: def.id,
      argusTarget: true,
      position: {
        // Cesium-style: getValue(time, result). Time comes from the scene clock.
        getValue: (_time, result) => {
          const rec = records.get(id);
          return rec ? positionOf(rec, result) : undefined;
        },
      },
    };
    return target;
  }

  // --- records --------------------------------------------------------------

  function upsert(normalized, batchTimeMs) {
    let rec = records.get(normalized.id);
    if (!rec) {
      rec = {
        id: normalized.id,
        normalized,
        history: createRingBuffer(historyCap),
        target: makeTarget(normalized.id),
        world: new Cesium.Cartesian3(),
        visible: true,
        dispose: null,
        cached: null,
      };
      records.set(normalized.id, rec);
      if (primitive) {
        rec.billboard = renderer.create(collection, rec.target, normalized, def.render);
      } else {
        rec.entity = ds.entities.add({ id: normalized.id });
        // A tap on the drawn line picks the Entity; the picker maps it back to
        // the layer target, which is what getRecord() and the tracker know.
        rec.entity._argusTarget = rec.target;
        rec.entity.position = new Cesium.CallbackProperty(
          (time, result) => positionOf(rec, result),
          false,
        );
        renderer.create(rec.entity, normalized, def.render);
      }
      if (def.onEntityCreate) {
        rec.dispose = def.onEntityCreate(rec.target, normalized, { viewer, scene });
      }
    }
    rec.normalized = normalized;
    rec.cached = null; // new elements: recompute the position
    rec.lastSeen = batchTimeMs; // for push-mode staleness removal
    if (primitive) renderer.update(rec.billboard, normalized, def.render);
    else renderer.update(rec.entity, normalized, def.render);
    // Compute-position layers keep no fix history (position is a function of time).
    if (!def.positionAt) {
      rec.history.push({
        t: batchTimeMs, // local ingest time: interpolation spacing is exactly one interval
        longitude: normalized.position.longitude,
        latitude: normalized.position.latitude,
        altitude: normalized.position.altitude,
      });
    }
    dirty = true;
  }

  function removeRecord(id) {
    const rec = records.get(id);
    if (!rec) return;
    rec.dispose?.();
    if (primitive) collection.remove(rec.billboard);
    else ds.entities.remove(rec.entity);
    records.delete(id);
    suppressed.delete(id);
    dirty = true;
  }

  function ingest(list, batchTimeMs = Date.now()) {
    const items = list.length > maxEntities ? list.slice(0, maxEntities) : list;
    const seen = new Set();
    for (const n of items) {
      seen.add(n.id);
      upsert(n, batchTimeMs);
    }
    for (const id of [...records.keys()]) if (!seen.has(id)) removeRecord(id);
    if (holdsRender) moversActive(true); // the fleet size sets the pace
    scene.requestRender();
  }

  // --- the per-frame update (billboard layers) --------------------------------

  const occluder = new Cesium.EllipsoidalOccluder(
    Cesium.Ellipsoid.WGS84,
    Cesium.Cartesian3.ZERO,
  );
  const lastCamera = new Cesium.Cartesian3();

  // Movers re-interpolate on a fleet tick, not every frame: camera moves
  // render at full rate but leave world positions unchanged, so those frames
  // only redo the horizon cull. The tick matches the paced frame rate, except
  // for a big fleet (thousands of contacts), which ticks and paces at 15 Hz so
  // no paced frame is spent on unchanged positions. A billboard's position is
  // written only when it moved more than a metre, since every write
  // re-uploads the vertex data of the whole collection. (Techniques from
  // gods-eye-view's fleet tick.)
  const BIG_FLEET = 3000;
  const bigFleet = () => records.size > BIG_FLEET;
  const paceFps = () => (bigFleet() ? Math.min(fps, 15) : fps);
  const tickMs = () => Math.max(12, 1000 / paceFps() - 4);
  let lastTick = 0;
  function onPreRender() {
    if (!running || !shown || !primitive) return;
    const cam = scene.camera.positionWC;
    const cameraMoved = !Cesium.Cartesian3.equalsEpsilon(cam, lastCamera, 0, 1);
    const now = performance.now();
    const tick = dirty || (isMover && now - lastTick >= tickMs());
    if (!tick && !cameraMoved) return;
    if (tick) lastTick = now;
    Cesium.Cartesian3.clone(cam, lastCamera);
    occluder.cameraPosition = cam;
    for (const rec of records.values()) {
      if (tick) {
        if (!positionOf(rec, rec.world)) {
          if (rec.billboard.show) rec.billboard.show = false;
          rec.visible = false;
          // Forget the old write, or camera-move frames would show it again.
          rec.written = undefined;
          continue;
        }
        if (
          !rec.written ||
          Cesium.Cartesian3.distanceSquared(rec.written, rec.world) > 1
        ) {
          rec.billboard.position = rec.world;
          rec.written = Cesium.Cartesian3.clone(rec.world, rec.written);
        }
      } else if (!rec.written) {
        continue; // never positioned yet: wait for the next tick
      }
      const visible = occluder.isPointVisible(rec.world);
      rec.visible = visible;
      const show = visible && !suppressed.has(rec.id);
      if (rec.billboard.show !== show) rec.billboard.show = show;
    }
    dirty = false;
  }
  const removePreRender = primitive
    ? scene.preRender.addEventListener(onPreRender)
    : null;

  // --- fetching -------------------------------------------------------------

  let lastPollAt = 0;
  let lastQuery = null; // the view the last bounded fetch asked for
  async function poll() {
    if (!running) return;
    lastPollAt = Date.now();
    // 'viewport' layers are fetched per region, so they are always bounded.
    const bounded = def.fetch?.viewportBounded || mode === 'viewport';
    const query = bounded ? computeViewportQuery(viewer) : {};
    if (bounded) lastQuery = query;
    aborter?.abort();
    const controller = new AbortController();
    aborter = controller;
    try {
      const raw = await ctx.source(query, controller.signal);
      // A superseded or paused poll may still resolve (multi-feed sources settle
      // with partial data): never ingest it.
      if (!running || controller.signal.aborted) return;
      ingest(def.normalize(raw));
      // An optional hint beside the count (e.g. "zoom in to load"), shared with
      // the terminal shell's statusNote.
      const note = def.statusNote?.(query, raw) || undefined;
      ctx.onStatus?.({ state: 'ok', count: records.size, query, note });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      ctx.onStatus?.({
        state: 'error',
        status: err?.status,
        message: String(err?.message || err),
      });
    }
  }

  // Push mode: incremental updates arrive over a stream (e.g. AIS). Entities are
  // upserted as they report and removed when they go stale, not by absence.
  let unsubscribe = null;
  let staleTimer = null;
  let moveEndRemove = null;
  let moveTimer = null;
  let driftTimer = null;

  function pushIngest(raw) {
    if (!running) return;
    const list = def.normalize(raw);
    const now = Date.now();
    for (const n of list.slice(0, maxEntities)) upsert(n, now);
    scene.requestRender();
    ctx.onStatus?.({ state: 'ok', count: records.size });
  }

  function sweepStale() {
    const cutoff = Date.now() - staleMs;
    for (const [id, rec] of records) if (rec.lastSeen < cutoff) removeRecord(id);
    if (holdsRender) moversActive(true);
    scene.requestRender();
  }

  function moversActive(on) {
    // Movers request frames at their pace, shared across layers (renderMode.js).
    if (!isMover) return;
    const rate = on ? paceFps() : 0;
    if (rate === holdsRender) return;
    if (holdsRender) releaseContinuousRender(scene, holdsRender);
    holdsRender = rate;
    if (rate) acquireContinuousRender(scene, rate);
  }

  function pausePolling() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    aborter?.abort();
  }
  function resumePolling() {
    if (!running || timer) return;
    poll();
    // Viewport layers refetch when the view settles, never on a timer.
    if (mode !== 'viewport') timer = setInterval(poll, intervalMs);
  }
  // Viewport-bounded layers refetch once the camera settles after a move, so a
  // city layer fills in when you arrive instead of on its next timer tick. A
  // timed layer refetches at most every 5 s this way, so panning cannot
  // multiply a metered feed's requests (OpenSky, FIRMS).
  const MOVE_REFETCH_GAP_MS = 5000;
  // A view that barely moved (GPS jitter under the car's follow camera, a
  // nudge) keeps the data it has: refetching costs a request and a rebuild
  // for the same records. viewportShift is in views: 0.04 is 4 % of the view.
  const SAME_VIEW = 0.04;
  // A camera that never settles (the car following the vehicle, a tracked
  // aircraft) never raises moveEnd, so every few seconds check whether the
  // view has drifted far enough off the fetched area to need the next one.
  const DRIFT_CHECK_MS = 4000;
  const DRIFT_REFETCH = 0.3;
  function refetchIfMoved(minShift) {
    if (!running || document.hidden) return;
    if (mode !== 'viewport' && Date.now() - lastPollAt < MOVE_REFETCH_GAP_MS) return;
    if (
      lastQuery &&
      viewportShift(lastQuery.bbox, computeViewportQuery(viewer).bbox) < minShift
    )
      return;
    poll();
  }
  function watchCamera() {
    moveEndRemove = viewer.camera.moveEnd.addEventListener(() => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => refetchIfMoved(SAME_VIEW), 700);
    });
    driftTimer = setInterval(() => refetchIfMoved(DRIFT_REFETCH), DRIFT_CHECK_MS);
  }
  function onVisibilityChange() {
    if (document.hidden) pausePolling();
    else resumePolling();
  }
  // Push streams (AIS, BGP) close while the page is hidden and reopen on return
  // (CLAUDE.md: Page Visibility pauses the AIS socket, with explicit resume). The
  // stale sweep keeps running, so vessels that went quiet meanwhile drop out and
  // the stream repopulates on resume.
  function onPushVisibilityChange() {
    if (!running) return;
    if (document.hidden) {
      unsubscribe?.();
      unsubscribe = null;
    } else if (!unsubscribe) {
      unsubscribe = ctx.source(pushIngest);
    }
  }

  function setShown(on) {
    shown = on;
    if (collection) collection.show = on;
    if (ds) ds.show = on;
    // Decorations a definition draws itself (orbit rings, camera frustums).
    def.onShow?.(on, { viewer, scene });
    dirty = true;
  }

  return {
    id: def.id,
    start() {
      if (running) return;
      running = true;
      setShown(true);
      moversActive(true);
      if (mode === 'push') {
        unsubscribe = document.hidden ? null : ctx.source(pushIngest);
        document.addEventListener('visibilitychange', onPushVisibilityChange);
        // Sweep at least as often as entities expire, so short-lived push layers
        // (e.g. BGP pulses) cull promptly instead of lingering to the next sweep.
        staleTimer = setInterval(sweepStale, Math.min(10_000, staleMs));
      } else if (mode === 'viewport') {
        document.addEventListener('visibilitychange', onVisibilityChange);
        poll();
        watchCamera();
      } else if (mode === 'once') {
        // Fetch a single time; entities persist (e.g. user-calibrated CCTV poses).
        poll();
      } else {
        document.addEventListener('visibilitychange', onVisibilityChange);
        poll();
        timer = setInterval(poll, intervalMs);
        if (def.fetch?.viewportBounded) watchCamera();
      }
      scene.requestRender();
    },
    stop() {
      running = false;
      if (mode === 'push') {
        document.removeEventListener('visibilitychange', onPushVisibilityChange);
        unsubscribe?.();
        unsubscribe = null;
        if (staleTimer) {
          clearInterval(staleTimer);
          staleTimer = null;
        }
      } else {
        pausePolling();
        document.removeEventListener('visibilitychange', onVisibilityChange);
        moveEndRemove?.();
        moveEndRemove = null;
        clearTimeout(moveTimer);
        clearInterval(driftTimer);
        driftTimer = null;
      }
      moversActive(false);
    },
    /** Fetch again now (a local source changed: saved places, a filter). */
    refresh() {
      if (running && mode !== 'push') poll();
    },
    setEnabled(on) {
      setShown(on);
      if (on) this.start();
      else this.stop();
      scene.requestRender();
    },
    destroy() {
      this.stop();
      removePreRender?.();
      for (const rec of records.values()) rec.dispose?.();
      records.clear();
      if (collection) scene.primitives.remove(collection);
      if (ds) viewer.dataSources.remove(ds, true);
    },
    get size() {
      return records.size;
    },
    get isMover() {
      return isMover;
    },
    // Per-layer search adapter (global search). Matches a query against each
    // entity's def.searchText; returns { id, entity, label }.
    search(query, limit = 6) {
      if (!def.searchText) return [];
      const q = String(query).trim().toLowerCase();
      if (!q) return [];
      const out = [];
      for (const rec of records.values()) {
        const text = String(def.searchText(rec.normalized) || '').toLowerCase();
        if (text.includes(q)) {
          out.push({
            id: rec.id,
            entity: rec.target,
            label: def.describe ? def.describe(rec.normalized).title : String(rec.id),
          });
          if (out.length >= limit) break;
        }
      }
      return out;
    },
    // What the interaction spine needs to resolve a picked target.
    /**
     * Prepend older fixes to one contact's history (a track fetched on
     * demand when it is selected), so its trail and the time scrubber reach
     * further back. fixes: [{ t, longitude, latitude, altitude }].
     */
    backfill(id, fixes, limit = 460) {
      const rec = records.get(id);
      return rec && Array.isArray(fixes) ? rec.history.prepend(fixes, limit) : 0;
    },
    getRecord(id) {
      const rec = records.get(id);
      if (!rec) return null;
      return {
        entity: rec.target,
        normalized: rec.normalized,
        mover: isMover,
        layerId: def.id,
        cardModel: def.describe ? def.describe(rec.normalized) : null,
        getHistoryFixes: () => rec.history.toArray(),
      };
    },
    /** Hide (or restore) one contact's glyph while something else draws it. */
    suppress(id, on) {
      if (on) suppressed.add(id);
      else suppressed.delete(id);
      dirty = true;
      scene.requestRender();
    },
    /** Visit every contact the layer holds (in view or not). */
    forEachRecord(fn) {
      for (const rec of records.values()) fn(rec.target, rec.normalized);
    },
    /**
     * Visit the targets drawn right now (in front of the planet), with their
     * world position as of the last rendered frame. The selection overlay and the
     * contacts roster use this; it allocates nothing.
     */
    forEachVisible(fn) {
      if (!running || !shown) return;
      for (const rec of records.values()) {
        if (!rec.visible) continue;
        if (!primitive && !positionOf(rec, rec.world)) continue;
        fn(rec.target, rec.world, rec.normalized);
      }
    },
    // Dev-only: feed a normalized list straight in for verification.
    _ingest: import.meta.env.DEV ? (list) => ingest(list) : undefined,
  };
}
