import * as Cesium from 'cesium';
import { createRingBuffer } from './ringBuffer.js';
import { interpolateInto } from './interpolate.js';
import { computeViewportQuery } from './viewport.js';
import { getRenderer, isPrimitiveRenderType } from './renderers.js';
import { createRasterLayer } from './rasterLayer.js';
import { createFieldLayer } from './fieldLayer.js';
import { layerInk } from './colors.js';
import {
  CLUSTER,
  createGridClusterer,
  clusterLabel,
  clusterSizePx,
  membersBox,
  clusterPolicy,
  fanOffset,
  cellKey,
} from './cluster.js';
import {
  tileOptions,
  tilesForView,
  tileCountForView,
  createTileStore,
  mergeTileRecords,
} from './tileCache.js';
import { clusterGlyph } from '../../ui/glyphs.js';
import {
  acquireContinuousRender,
  releaseContinuousRender,
} from '../../scene/renderMode.js';

// The Layer SDK engine. A layer is config against this interface, not bespoke
// code (CLAUDE.md): fetch -> normalize -> render -> interpolate?, with
// viewport-bounded fetch and load-only-in-view baked in.
//
// A LayerDefinition (static, reusable) provides:
//   id, fetch:{ mode, intervalMs, viewportBounded, tileCache? },
//   normalize(raw) -> NormalizedEntity[],
//   render:{ renderType, style(normalized)->styleProps, ...renderConfig },
//   interpolate?:boolean, historyCapacity?, interpolateLagMs?, maxEntities?,
//   positionAt?(normalized, timeMs), positionCacheMs?, animationFps?,
//   describe?(normalized) -> cardModel   (for the interaction spine)
//   statusNote?(query, raw) -> string     (a hint shown beside the count)
//   onEntityCreate?(target, normalized, { viewer, scene }) -> dispose
//   onShow?(shown, { viewer, scene })      (hide decorations with the layer)
//   cluster?: false                        (never merge this layer's contacts)
//
// fetch.tileCache: { tileDeg, ttlMs, maxTiles } (mode 'viewport'): static
// infrastructure is fetched once per fixed tile and kept (./tileCache.js). The
// source gets query.bbox = the tile's box and query.tile = its key (plus
// query.reload = true after RELOAD); the SDK writes the status note itself
// ("zoom in to load" when a view needs more than tileCache.maxView tiles), so
// statusNote is not called for such a layer.
//
// A NormalizedEntity is { id, position:{longitude,latitude,altitude}, type,
// meta, velocity? } per the contract.
//
// Merge nearby. Point and billboard layers cluster in screen space while the
// camera is high (./cluster.js): the members of a group are hidden (not drawn,
// not pickable, not visible to forEachVisible) and one marker with the count
// stands in for them; tapping it flies to fit the group. The scene's cluster
// policy switches it (the MERGE NEARBY setting, a hold while riding along) and
// keeps the selected target out of every group.
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
 *   key?: string, log?: Function }} ctx  key: the manager's layer key (its ink);
 *   log: an optional log sink for failures ({ level, source, title, body }).
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
      Math.max(0, fix.altitude),
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
        // Merge nearby: in front of the planet (hv), the grid cell of the last
        // recluster, whether it is hidden inside a group and which, and its
        // last geodetic position (to fit a group's members).
        hv: false,
        cell: -1,
        clustered: false,
        cluster: null,
        lon: 0,
        lat: 0,
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

  // Draw state of one record from its horizon test and its group: hidden in a
  // group or behind the planet is not visible; a suppressed one (drawn as a 3D
  // model) stays visible with its glyph off.
  function apply(rec) {
    const visible = rec.hv && !rec.clustered;
    rec.visible = visible;
    const show = visible && !suppressed.has(rec.id);
    if (rec.billboard.show !== show) rec.billboard.show = show;
  }

  function onPreRender() {
    if (!running || !shown || !primitive) return;
    const camera = scene.camera;
    const cam = camera.positionWC;
    const cameraMoved = !Cesium.Cartesian3.equalsEpsilon(cam, lastCamera, 0, 1);
    const now = performance.now();
    const tick = dirty || (isMover && now - lastTick >= tickMs());
    const cluster = clusterable && clusterDue(cameraMoved, tick, now);
    if (!tick && !cameraMoved && !cluster) return;
    if (tick) lastTick = now;
    Cesium.Cartesian3.clone(cam, lastCamera);
    occluder.cameraPosition = cam;
    for (const rec of records.values()) {
      if (tick) {
        if (!positionOf(rec, rec.world)) {
          if (rec.billboard.show) rec.billboard.show = false;
          rec.visible = false;
          rec.hv = false;
          // Forget the old write, or camera-move frames would show it again.
          rec.written = undefined;
          continue;
        }
        rec.lon = fix.longitude;
        rec.lat = fix.latitude;
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
      rec.hv = occluder.isPointVisible(rec.world);
      apply(rec);
    }
    dirty = false;
    // Regroup with the positions and horizon flags just computed.
    if (cluster && recluster(now)) {
      const on = clustersOn;
      for (const rec of records.values()) {
        const slot = on && rec.cell >= 0 ? grid.slotOf(rec.cell) : -1;
        rec.clustered = slot >= 0;
        rec.cluster = slot >= 0 ? pool[slot].target : null;
        apply(rec);
      }
    }
  }

  // --- merge nearby -----------------------------------------------------------
  // Screen-space groups (./cluster.js), recomputed only when the view turned or
  // moved, the records changed, or the policy changed, at most 4 Hz (movers
  // under a still camera once a second), with a trailing pass once the camera
  // settles. One BillboardCollection of pooled markers per layer.

  const clusterable = primitive && def.cluster !== false;
  const policy = clusterable ? clusterPolicy(scene) : null;
  const grid = clusterable ? createGridClusterer() : null;
  const cellPx =
    def.cluster?.cellPx ??
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
      ? CLUSTER.cellTouchPx
      : CLUSTER.cellPx);
  const minClusterHeight = def.cluster?.minHeightM ?? CLUSTER.minHeightM;
  const clusterInk = clusterable ? layerInk(ctx.key ?? def.id) : null;
  let markers = null; // the markers' BillboardCollection, made on first use
  const pool = []; // { billboard, target, label, px, written }
  let shownMarkers = 0;
  let clustersOn = false; // members are hidden in groups right now
  let clusterStale = true;
  let moversDrifted = false;
  let lastClusterAt = -Infinity;
  let policyVersion = -1;
  let clusterTimer = null;
  const lastDir = new Cesium.Cartesian3();
  // The grid follows a world anchor shared by the scene's layers, so it slides
  // with the globe in a pan and every layer cuts the screen the same way.
  const anchor = policy?.anchor;
  let fanToken = 0; // this layer's token with the policy while running
  const fanKeys = []; // per group: its cell key, then its slot in that cell
  const fanSlots = [];
  const cellAt = { x: 0, y: 0 };
  // World to window, CSS px: one matrix per pass, a few multiplies per contact.
  const viewProj = new Cesium.Matrix4();
  const win = new Cesium.Cartesian2();
  let fastProject = false;
  let viewW = 0;
  let viewH = 0;
  let sx = 0;
  let sy = 0;

  function clusterDue(cameraMoved, tick, now) {
    if (
      cameraMoved ||
      dirty ||
      policy.version !== policyVersion ||
      policy.takePoke(fanToken) ||
      !Cesium.Cartesian3.equalsEpsilon(scene.camera.directionWC, lastDir, 1e-9)
    ) {
      clusterStale = true;
    } else if (isMover && tick && clustersOn) {
      moversDrifted = true;
    }
    if (!clusterStale && !moversDrifted) return false;
    const wait =
      (clusterStale ? CLUSTER.intervalMs : CLUSTER.moverIntervalMs) -
      (now - lastClusterAt);
    if (wait <= 0) return true;
    if (!clusterTimer) {
      clusterTimer = setTimeout(() => {
        clusterTimer = null;
        if (running && shown) scene.requestRender();
      }, wait + 4);
    }
    return false;
  }

  function setupProjection() {
    const camera = scene.camera;
    viewW = scene.canvas.clientWidth;
    viewH = scene.canvas.clientHeight;
    const view = camera.viewMatrix;
    const proj = camera.frustum?.projectionMatrix;
    fastProject = Boolean(view && proj && Cesium.Matrix4.multiply);
    if (fastProject) Cesium.Matrix4.multiply(proj, view, viewProj);
  }

  /** Window position of a world point into sx, sy; false behind the camera. */
  function project(p) {
    if (fastProject) {
      const m = viewProj;
      const w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
      if (!(w > 1e-9)) return false;
      sx = (((m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12]) / w) * 0.5 + 0.5) * viewW;
      sy = (0.5 - ((m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13]) / w) * 0.5) * viewH;
      return true;
    }
    const r = Cesium.SceneTransforms.worldToWindowCoordinates(scene, p, win);
    if (!r) return false;
    sx = r.x;
    sy = r.y;
    return true;
  }

  /** The anchor's window position into sx, sy (re-anchored when it wandered off). */
  const anchorAt = new Cesium.Cartesian3();
  function anchorOnScreen() {
    if (
      anchor.ok &&
      project(anchor) &&
      sx > -viewW &&
      sx < 2 * viewW &&
      sy > -viewH &&
      sy < 2 * viewH
    )
      return true;
    win.x = viewW / 2;
    win.y = viewH / 2;
    const hit = scene.camera.pickEllipsoid(win, Cesium.Ellipsoid.WGS84, anchorAt);
    anchor.ok = Boolean(hit);
    if (hit) {
      anchor.x = hit.x;
      anchor.y = hit.y;
      anchor.z = hit.z;
    }
    return anchor.ok && project(anchor);
  }

  function marker(i) {
    if (pool[i]) return pool[i];
    if (!markers) {
      markers = scene.primitives.add(new Cesium.BillboardCollection());
      markers.show = shown;
    }
    const target = {
      id: `cluster:${def.id}:${i}`,
      layerId: def.id,
      argusCluster: true,
      count: 0,
      world: new Cesium.Cartesian3(),
      position: {
        getValue: (_time, result) =>
          Cesium.Cartesian3.clone(target.world, result ?? new Cesium.Cartesian3()),
      },
      /** The box around the group's members (degrees), to fly to. */
      bounds: () => {
        const pts = [];
        for (const rec of records.values())
          if (rec.clustered && rec.cluster === target) pts.push(rec);
        return membersBox(pts);
      },
    };
    const billboard = markers.add({
      position: Cesium.Cartesian3.ZERO,
      show: false,
      id: target,
      color: clusterInk,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    });
    pool[i] = {
      billboard,
      target,
      label: '',
      px: 1,
      written: null,
      slot: 0,
      offset: new Cesium.Cartesian2(),
    };
    return pool[i];
  }

  function hideMarkers(from) {
    for (let i = from; i < shownMarkers; i += 1) pool[i].billboard.show = false;
    shownMarkers = from;
  }

  /**
   * Regroup. Returns whether the groups may have changed (the caller then
   * re-applies every record's flags).
   */
  function recluster(now) {
    lastClusterAt = now;
    clusterStale = false;
    moversDrifted = false;
    policyVersion = policy.version;
    Cesium.Cartesian3.clone(scene.camera.directionWC, lastDir);
    const wanted =
      policy.active && scene.camera.positionCartographic.height >= minClusterHeight;
    if (!wanted) {
      const was = clustersOn || shownMarkers > 0;
      clustersOn = false;
      hideMarkers(0);
      fanKeys.length = 0;
      policy.place(fanToken, fanKeys);
      return was;
    }
    setupProjection();
    const anchoredNow = anchorOnScreen();
    const ax = anchoredNow ? sx : 0;
    const ay = anchoredNow ? sy : 0;
    grid.begin(viewW, viewH, cellPx, ax, ay);
    const pinned = policy.pinned;
    for (const rec of records.values()) {
      rec.cell = -1;
      if (!rec.hv || !rec.written || rec.target === pinned || suppressed.has(rec.id))
        continue;
      if (project(rec.world)) {
        rec.cell = grid.add(sx, sy, rec.world.x, rec.world.y, rec.world.z);
      }
    }
    const n = grid.finish(CLUSTER.minPoints);
    // Groups of other layers in the same cell: each takes its own spot.
    fanKeys.length = n;
    for (let i = 0; i < n; i += 1) {
      grid.cellCenter(i, cellAt);
      fanKeys[i] = cellKey(cellAt.x, cellAt.y, ax, ay, cellPx);
    }
    policy.place(fanToken, fanKeys, fanSlots);
    for (let i = 0; i < n; i += 1) {
      const m = marker(i);
      const slot = fanSlots[i] ?? 0;
      if (m.slot !== slot) {
        const [dx, dy] = fanOffset(slot);
        m.offset.x = dx;
        m.offset.y = dy;
        m.billboard.pixelOffset = m.offset;
        m.slot = slot;
      }
      const count = grid.count(i);
      m.target.count = count;
      grid.centroid(i, m.target.world);
      const label = clusterLabel(count);
      if (m.label !== label) {
        const g = clusterGlyph(label);
        m.billboard.setImage(g.id, g.image);
        m.label = label;
        m.px = g.px;
      }
      const scale = clusterSizePx(count) / m.px;
      if (m.billboard.scale !== scale) m.billboard.scale = scale;
      if (
        !m.written ||
        Cesium.Cartesian3.distanceSquared(m.written, m.target.world) > 1
      ) {
        m.billboard.position = m.target.world;
        m.written = Cesium.Cartesian3.clone(m.target.world, m.written ?? undefined);
      }
      if (!m.billboard.show) m.billboard.show = true;
    }
    if (n > shownMarkers) shownMarkers = n;
    hideMarkers(n);
    clustersOn = n > 0;
    return true;
  }

  const removePreRender = primitive
    ? scene.preRender.addEventListener(onPreRender)
    : null;

  // --- fetching -------------------------------------------------------------

  let lastPollAt = 0;
  /** reload: the user pressed RELOAD (sources may skip their own memo). */
  async function poll({ reload = false } = {}) {
    if (!running) return;
    if (tileCfg) {
      pollTiles(reload);
      return;
    }
    lastPollAt = Date.now();
    // 'viewport' layers are fetched per region, so they are always bounded.
    const bounded = def.fetch?.viewportBounded || mode === 'viewport';
    const query = bounded ? computeViewportQuery(viewer) : {};
    if (reload) query.reload = true;
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

  // --- fetch once: the tile cache (fetch.tileCache, ./tileCache.js) -----------
  // Each camera stop lists the tiles the view needs, nearest first; cached and
  // fresh ones cost nothing, the rest are fetched a couple at a time. Requests
  // already in flight finish even if the view moved on (the tile is still worth
  // keeping); queued ones that left the view are dropped. Every cached tile is
  // drawn (nearest first, so the entity cap keeps what is around you).

  const tileCfg =
    def.fetch?.tileCache && mode === 'viewport' ? tileOptions(def.fetch.tileCache) : null;
  const tiles = tileCfg ? createTileStore(tileCfg) : null;
  let tileQueue = [];
  const tileFlights = new Map(); // key -> AbortController
  let tileView = null; // { bbox, broad }
  let tileFailures = 0; // in the current view
  let tileError = '';
  let shownTiles = '';
  let showTimer = null;
  let tilesFetched = 0; // requests sent (dev stats)

  function pollTiles(reload) {
    lastPollAt = Date.now();
    const { bbox } = computeViewportQuery(viewer);
    const broad = tileCountForView(bbox, tileCfg.tileDeg) > tileCfg.maxView;
    tileView = { bbox, broad };
    tileFailures = 0;
    const want = broad ? [] : tilesForView(bbox, tileCfg.tileDeg);
    for (const t of want) tiles.touch(t.key); // in view: evicted last
    tileQueue = want.filter(
      (t) =>
        !tileFlights.has(t.key) &&
        (reload || (!tiles.isFresh(t.key) && !tiles.isCoolingDown(t.key))),
    );
    for (const t of tileQueue) t.reload = reload;
    showTiles();
    pumpTiles();
    reportTiles();
  }

  function pumpTiles() {
    while (running && tileFlights.size < tileCfg.concurrency && tileQueue.length) {
      fetchTile(tileQueue.shift());
    }
  }

  async function fetchTile(t) {
    const controller = new AbortController();
    tileFlights.set(t.key, controller);
    try {
      const query = { bbox: t.bbox, tile: t.key };
      if (t.reload) query.reload = true;
      tilesFetched += 1;
      const raw = await ctx.source(query, controller.signal);
      if (controller.signal.aborted) return;
      tiles.set(t.key, { bbox: t.bbox, raw, list: def.normalize(raw) });
      if (!showTimer) showTimer = setTimeout(showTiles, 120); // batch arrivals
    } catch (err) {
      if (err?.name === 'AbortError' || controller.signal.aborted) return;
      tiles.fail(t.key);
      tileFailures += 1;
      tileError = String(err?.message || err);
      // No popup (feed failures go to the menu row and the log), and the tile
      // is not asked again for a minute.
      console.warn(`[argus] ${def.id}: tile ${t.key} failed: ${tileError}`);
      ctx.log?.({
        level: 'warn',
        source: ctx.key ?? def.id,
        title: `${String(ctx.key ?? def.id).toUpperCase()} TILE FAILED`,
        body: `${t.key}: ${tileError}`,
      });
    } finally {
      if (tileFlights.get(t.key) === controller) tileFlights.delete(t.key);
      pumpTiles();
      reportTiles();
    }
  }

  // Draw every cached tile's records; skipped when the set is unchanged.
  function showTiles() {
    clearTimeout(showTimer);
    showTimer = null;
    if (!running) return;
    const entries = [...tiles.values()];
    const total = entries.reduce((s, e) => s + (e.list?.length ?? 0), 0);
    const b = tileView?.bbox;
    if (b && total > maxEntities) {
      // Over the cap the order decides what is kept: nearest the view first.
      const cLat = (b.lamin + b.lamax) / 2;
      const cLon = (b.lomin + b.lomax) / 2;
      const d = (e) =>
        Math.hypot(
          (e.bbox.lamin + e.bbox.lamax) / 2 - cLat,
          (e.bbox.lomin + e.bbox.lomax) / 2 - cLon,
        );
      entries.sort((p, q) => d(p) - d(q));
    } else {
      entries.sort((p, q) => (p.key < q.key ? -1 : 1));
    }
    const sig = entries.map((e) => `${e.key}@${e.at}`).join('|');
    if (sig === shownTiles) return;
    shownTiles = sig;
    ingest(mergeTileRecords(entries, maxEntities));
    reportTiles();
  }

  function reportTiles() {
    if (!running) return;
    const pending = tileFlights.size + tileQueue.length;
    if (!records.size && pending) {
      ctx.onStatus?.({ state: 'loading' });
      return;
    }
    if (!records.size && tileFailures && tileError) {
      ctx.onStatus?.({ state: 'error', message: tileError });
      return;
    }
    const note = tileView?.broad
      ? 'zoom in to load'
      : pending
        ? `loading ${pending} tile${pending > 1 ? 's' : ''}`
        : tileFailures
          ? `${tileFailures} tile${tileFailures > 1 ? 's' : ''} failed: ${tileError}`
          : undefined;
    ctx.onStatus?.({
      state: 'ok',
      count: records.size,
      query: { bbox: tileView?.bbox },
      note,
      pending,
    });
  }

  function abortTiles() {
    for (const c of tileFlights.values()) c.abort();
    tileFlights.clear();
    tileQueue = [];
    clearTimeout(showTimer);
    showTimer = null;
  }

  // Push mode: incremental updates arrive over a stream (e.g. AIS). Entities are
  // upserted as they report and removed when they go stale, not by absence.
  let unsubscribe = null;
  let staleTimer = null;
  let moveEndRemove = null;
  let moveTimer = null;

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
    if (tileCfg) abortTiles();
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
  function watchCamera() {
    moveEndRemove = viewer.camera.moveEnd.addEventListener(() => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (!running || document.hidden) return;
        if (mode !== 'viewport' && Date.now() - lastPollAt < MOVE_REFETCH_GAP_MS) return;
        poll();
      }, 700);
    });
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
    if (markers) markers.show = on;
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
      if (clusterable && !fanToken) fanToken = policy.join();
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
      }
      moversActive(false);
      if (fanToken) {
        policy.leave(fanToken);
        fanToken = 0;
      }
    },
    /** Fetch again now (a local source changed: saved places, a filter). */
    refresh() {
      if (!running || mode === 'push') return;
      if (tileCfg) {
        // A filter changed: redraw from the cached answers, no new request.
        for (const e of tiles.values()) e.list = def.normalize(e.raw);
        shownTiles = '';
        showTiles();
        reportTiles();
        return;
      }
      poll();
    },
    /**
     * RELOAD: fetch the view again now, past every cache this side of the
     * proxy (each cached tile counts as expired; the source gets
     * query.reload). What is drawn stays until the new answers arrive.
     */
    reload() {
      if (!running || !this.reloadable) return false;
      if (tileCfg) tiles.expireAll();
      poll({ reload: true });
      return true;
    },
    /** Whether RELOAD means something here: cached tiles or a slow poll. */
    get reloadable() {
      return (
        Boolean(tileCfg) ||
        mode === 'viewport' ||
        (mode === 'poll' && intervalMs >= 5 * 60_000)
      );
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
      clearTimeout(clusterTimer);
      for (const rec of records.values()) rec.dispose?.();
      records.clear();
      if (collection) scene.primitives.remove(collection);
      if (markers) scene.primitives.remove(markers);
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
    // Dev-only: what the cache and the groups hold right now.
    _stats: import.meta.env.DEV
      ? () => ({
          tiles: tiles?.size ?? 0,
          tilesFetched,
          tilesPending: tileFlights.size + tileQueue.length,
          groups: clustersOn ? shownMarkers : 0,
          grouped: [...records.values()].filter((r) => r.clustered).length,
          drawn: [...records.values()].filter((r) => r.billboard?.show).length,
        })
      : undefined,
  };
}
